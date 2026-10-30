import { applyD1Migrations, createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import type { Bindings } from '../src/env'
import { app } from '../src/index'
import { resetDb, seedDestination, updateDestination } from './support/fixtures'

const AUD = 'synthetic-common-aud'
const GUILD = '1234567890123456789'
const CHANNEL = '1234567890123456790'
const THREAD = '1234567890123456791'
const WEBHOOK = '18446744073709551615'
const OTHER = '18446744073709551614'
const TOKEN = 'synthetic-webhook-token-0123456789'
const store = new D1DestinationStore(env.DB)
const bindings = { DB: env.DB, ACCESS_AUD: AUD }

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))
beforeEach(() => resetDb(env.DB))

async function request(
  operation: string,
  body?: unknown,
  options: {
    aud?: string | null
    bindings?: Bindings
    method?: string
    raw?: string
  } = {},
) {
  const ctx = createExecutionContext()
  Object.defineProperty(ctx, 'access', { value: options.aud === null ? undefined : { aud: options.aud ?? AUD } })
  const response = await app.fetch(
    new Request(`https://example.com/internal/v2/cleanup${operation}`, {
      method: options.method ?? (body === undefined && options.raw === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        'CF-Access-Client-Id': 'forged',
        'CF-Access-Client-Secret': 'forged',
      },
      body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }),
    options.bindings ?? bindings,
    ctx,
  )
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return response
}

async function seed() {
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, webhook: { id: WEBHOOK, token: TOKEN } })
  await seedDestination(env.DB, {
    targetId: THREAD,
    channelId: CHANNEL,
    threadId: THREAD,
    guildId: GUILD,
    webhook: { id: WEBHOOK, token: TOKEN },
  })
}

async function exists(targetId: string) {
  return (await store.getDestination(targetId)) !== null
}

describe('Cleanup authorization boundary', () => {
  it.each([null, 'other-application', 'wrong', `${AUD} `, AUD.toUpperCase()])(
    'rejects unauthenticated/wrong audience %s before DB access',
    async (aud) => {
      await seed()
      const before = await store.loadSnapshot()
      const readDb = vi.fn(() => env.DB)
      for (const path of ['', '/', '/meta', '/guild', '/unknown']) {
        const response = await request(
          path,
          { guildId: GUILD },
          {
            aud,
            bindings: {
              ACCESS_AUD: AUD,
              get DB() {
                return readDb()
              },
            },
          },
        )
        expect(response.status).toBe(403)
      }
      expect(readDb).not.toHaveBeenCalled()
      expect(await store.loadSnapshot()).toEqual(before)
    },
  )

  it.each([undefined, '', '   '])('fails closed with missing common binding %s', async (ACCESS_AUD) => {
    const response = await request('/meta', undefined, { bindings: { ACCESS_AUD } })
    expect(response.status).toBe(503)
  })

  it('allows the same common context to read snapshots', async () => {
    const ctx = createExecutionContext()
    Object.defineProperty(ctx, 'access', { value: { aud: AUD } })
    const readDb = vi.fn(() => env.DB)
    const response = await app.fetch(
      new Request('https://example.com/internal/v2/config/snapshot'),
      {
        ...bindings,
        get DB() {
          return readDb()
        },
      },
      ctx,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revision: 0, destinations: [] })
    expect(readDb).toHaveBeenCalled()
  })

  it('allows common context to clean up and observe the changed snapshot', async () => {
    await seed()
    expect(await (await request('/guild', { guildId: GUILD })).json()).toEqual({ affected: 2 })
    const ctx = createExecutionContext()
    Object.defineProperty(ctx, 'access', { value: { aud: AUD } })
    const response = await app.fetch(new Request('https://example.com/internal/v2/config/snapshot'), bindings, ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revision: 3, destinations: [] })
  })

  it.each(['', '/', '/unknown', '/guild/', '/guild/extra'])('rejects unknown/noncanonical route %s', async (path) => {
    expect((await request(path, { guildId: GUILD })).status).toBe(404)
    expect(await store.getRevision()).toBe(0)
  })
})

describe('Cleanup over actual migrated local D1', () => {
  it.each([
    ['/guild', { guildId: GUILD }],
    ['/destinations', { targetIds: [CHANNEL, THREAD, CHANNEL] }],
    [
      '/webhooks',
      {
        targets: [
          { targetId: CHANNEL, expectedWebhookId: WEBHOOK },
          { targetId: THREAD, expectedWebhookId: WEBHOOK },
        ],
      },
    ],
    ['/webhook-ids', { webhookIds: [WEBHOOK, WEBHOOK] }],
  ])('changes two rows once and repeats as no-op: %s', async (path, body) => {
    await seed()
    const response = await request(path as string, body)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ affected: 2 })
    expect(await store.getRevision()).toBe(3)
    expect(await (await request(path as string, body)).json()).toEqual({ affected: 0 })
    expect(await store.getRevision()).toBe(3)
  })

  it.each([CHANNEL, THREAD])('deletes only exact channel/thread target %s', async (id) => {
    await seed()
    expect(await (await request('/destinations', { targetIds: [id] })).json()).toEqual({ affected: 1 })
    expect(await exists(id === CHANNEL ? THREAD : CHANNEL)).toBe(true)
  })

  it('preserves a newly replaced webhook against a delayed failure notification', async () => {
    await seed()
    await updateDestination(env.DB, CHANNEL, { webhook_id: OTHER, webhook_token: `new-${TOKEN}` })
    expect(
      await (await request('/webhooks', { targets: [{ targetId: CHANNEL, expectedWebhookId: WEBHOOK }] })).json(),
    ).toEqual({ affected: 0 })
    expect((await store.getDestination(CHANNEL))?.webhook?.id).toBe(OTHER)
    expect(await store.getRevision()).toBe(3)
  })

  it('clears both webhook columns together', async () => {
    await seed()
    await request('/webhook-ids', { webhookIds: [WEBHOOK] })
    const rows = await env.DB.prepare('SELECT webhook_id, webhook_token FROM destinations').all()
    expect(rows.results).toEqual([
      { webhook_id: null, webhook_token: null },
      { webhook_id: null, webhook_token: null },
    ])
  })

  it('preserves adjacent uint64 snowflakes and supports all 500 bound targets', async () => {
    await seedDestination(env.DB, { targetId: WEBHOOK })
    await seedDestination(env.DB, { targetId: OTHER })
    const targetIds = [WEBHOOK, ...Array.from({ length: 499 }, (_, i) => String(i + 1))]
    expect(await (await request('/destinations', { targetIds })).json()).toEqual({ affected: 1 })
    expect(await exists(OTHER)).toBe(true)
    expect(await store.getRevision()).toBe(3)
  })

  it.each([
    ['/guild', { guildId: OTHER }],
    ['/destinations', { targetIds: [] }],
    ['/webhooks', { targets: [] }],
    ['/webhook-ids', { webhookIds: [] }],
  ])('returns zero for no-op %s', async (path, body) => {
    expect(await (await request(path as string, body)).json()).toEqual({ affected: 0 })
    expect(await store.getRevision()).toBe(0)
  })

  it.each([
    ['/guild', { guildId: 123 }],
    ['/guild', { guildId: '01' }],
    ['/guild', { guildId: '18446744073709551616' }],
    ['/guild', null],
    ['/destinations', { targetIds: [CHANNEL, null] }],
    ['/destinations', { targetIds: Array(501).fill(CHANNEL) }],
    ['/destinations', { targetIds: '1' }],
    ['/webhooks', { targets: [{ targetId: CHANNEL }] }],
    ['/webhook-ids', { webhookIds: ['https://discord.com/api/webhooks/123/synthetic-secret'] }],
    ['/webhook-ids', { webhookIds: ['1\n'] }],
  ])('rejects invalid input before DB access: %s %j', async (path, body) => {
    const readDb = vi.fn(() => env.DB)
    const response = await request(path as string, body, {
      bindings: {
        ...bindings,
        get DB() {
          return readDb()
        },
      },
    })
    expect(response.status).toBe(400)
    expect(readDb).not.toHaveBeenCalled()
  })

  it('ignores unknown fields', async () => {
    await seed()
    expect(await (await request('/guild', { guildId: GUILD, reason: 'kicked' })).json()).toEqual({ affected: 2 })
  })

  it.each(['{', '{} {}', '[1]', ''])('rejects malformed JSON %j', async (raw) => {
    expect((await request('/guild', undefined, { raw })).status).toBe(400)
  })

  it.each(['/guild', '/destinations', '/webhooks', '/webhook-ids'])(
    'rolls back %s when revision fails and sanitizes the error',
    async (path) => {
      await seed()
      const before = await store.loadSnapshot()
      await env.DB.prepare(`CREATE TRIGGER cleanup_fail_revision AFTER UPDATE ON config_meta
      BEGIN SELECT RAISE(ABORT, 'synthetic-webhook-token'); END`).run()
      try {
        const body =
          path === '/guild'
            ? { guildId: GUILD }
            : path === '/destinations'
              ? { targetIds: [CHANNEL, THREAD] }
              : path === '/webhooks'
                ? { targets: [{ targetId: CHANNEL, expectedWebhookId: WEBHOOK }] }
                : { webhookIds: [WEBHOOK] }
        const response = await request(path, body)
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: { code: 'storage_unavailable' } })
        expect(await store.loadSnapshot()).toEqual(before)
      } finally {
        await env.DB.prepare('DROP TRIGGER cleanup_fail_revision').run()
      }
    },
  )
})
