import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import type { Bindings } from '../src/env'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import { MAX_CLEANUP_BYTES } from '../src/routes/cleanup'

const READ = 'synthetic-read-aud'
const WRITE = 'synthetic-cleanup-aud'
const GUILD = '1234567890123456789'
const CHANNEL = '1234567890123456790'
const THREAD = '1234567890123456791'
const WEBHOOK = '18446744073709551615'
const OTHER = '18446744073709551614'
const store = new D1DestinationStore(env.DB)
const bindings = { DB: env.DB, ACCESS_AUD: READ, ACCESS_CLEANUP_AUD: WRITE }

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM destinations'),
    env.DB.prepare('UPDATE config_meta SET channels_revision = 0 WHERE id = 1'),
  ])
})

async function request(operation: string, body?: unknown, options: {
  aud?: string | null, bindings?: Bindings, method?: string, raw?: string,
} = {}) {
  const ctx = createExecutionContext()
  Object.defineProperty(ctx, 'access', { value: options.aud === null ? undefined : { aud: options.aud ?? WRITE } })
  const response = await app.fetch(new Request(`https://example.com/internal/v1/cleanup${operation}`, {
    method: options.method ?? (body === undefined && options.raw === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', 'CF-Access-Client-Id': 'forged', 'CF-Access-Client-Secret': 'forged' },
    body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), options.bindings ?? bindings, ctx)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return response
}

async function seed() {
  await store.insertDestinationIfAbsent({ targetId: CHANNEL, channelId: CHANNEL, guildId: GUILD,
    webhookUrl: `https://discord.com/api/webhooks/${WEBHOOK}/synthetic` })
  await store.insertDestinationIfAbsent({ targetId: THREAD, channelId: CHANNEL, threadId: THREAD, guildId: GUILD,
    webhookUrl: `https://discord.com/api/webhooks/${WEBHOOK}/synthetic?thread_id=${THREAD}` })
}

describe('Cleanup authorization boundary', () => {
  it.each([null, READ, 'wrong', `${WRITE} `, WRITE.toUpperCase()])('rejects unauthenticated/wrong audience %s before DB access', async (aud) => {
    await seed()
    const before = await store.loadSnapshot()
    const readDb = vi.fn(() => env.DB)
    for (const path of ['', '/', '/meta', '/guild', '/unknown']) {
      const response = await request(path, { guildId: GUILD }, {
        aud, bindings: { ACCESS_AUD: READ, ACCESS_CLEANUP_AUD: WRITE, get DB() { return readDb() } },
      })
      expect(response.status).toBe(403)
    }
    expect(readDb).not.toHaveBeenCalled()
    expect(await store.loadSnapshot()).toEqual(before)
  })

  it.each([undefined, '', '   '])('fails closed with missing cleanup binding %s', async (ACCESS_CLEANUP_AUD) => {
    const response = await request('/meta', undefined, { bindings: { ACCESS_AUD: READ, ACCESS_CLEANUP_AUD } })
    expect(response.status).toBe(503)
  })

  it('rejects cleanup credentials at the snapshot boundary', async () => {
    const ctx = createExecutionContext()
    Object.defineProperty(ctx, 'access', { value: { aud: WRITE } })
    const readDb = vi.fn(() => env.DB)
    const response = await app.fetch(new Request('https://example.com/internal/v1/config/snapshot'),
      { ...bindings, get DB() { return readDb() } }, ctx)
    expect(response.status).toBe(403)
    expect(readDb).not.toHaveBeenCalled()
  })

  it.each(['', '/', '/unknown', '/guild/', '//guild', '/%67uild', '/guild/extra'])('rejects unknown/noncanonical route %s', async (path) => {
    expect((await request(path, { guildId: GUILD })).status).toBe(404)
    expect(await store.getRevision()).toBe(0)
  })

  it.each(['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'GET', 'HEAD'])('does not mutate on method %s', async (method) => {
    await seed()
    const before = await store.loadSnapshot()
    expect((await request('/guild', undefined, { method })).status).toBe(404)
    expect(await store.loadSnapshot()).toEqual(before)
  })

  it('advertises cleanup independently of read AUD and DB configuration', async () => {
    const response = await request('/meta', undefined, { bindings: { ACCESS_CLEANUP_AUD: WRITE } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ apiVersion: 1, capabilities: ['destinationCleanup'] })
  })
})

describe('Cleanup over actual migrated local D1', () => {
  it.each([
    ['/guild', { guildId: GUILD }],
    ['/destinations', { targetIds: [CHANNEL, THREAD, CHANNEL] }],
    ['/webhooks', { targets: [{ targetId: CHANNEL, expectedWebhookId: WEBHOOK }, { targetId: THREAD, expectedWebhookId: WEBHOOK }] }],
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
    expect(await store.destinationExists(id === CHANNEL ? THREAD : CHANNEL)).toBe(true)
  })

  it('preserves a newly replaced webhook against a delayed failure notification', async () => {
    await seed()
    await store.setWebhook(CHANNEL, `https://discord.com/api/webhooks/${OTHER}/new-synthetic`)
    expect(await (await request('/webhooks', { targets: [{ targetId: CHANNEL, expectedWebhookId: WEBHOOK }] })).json())
      .toEqual({ affected: 0 })
    expect((await store.getDestination(CHANNEL))?.webhookId).toBe(OTHER)
    expect(await store.getRevision()).toBe(3)
  })

  it('preserves adjacent uint64 snowflakes and supports all 500 bound targets', async () => {
    await store.insertDestinationIfAbsent({ targetId: WEBHOOK, channelId: WEBHOOK })
    await store.insertDestinationIfAbsent({ targetId: OTHER, channelId: OTHER })
    const targetIds = [WEBHOOK, ...Array.from({ length: 499 }, (_, i) => String(i + 1))]
    expect(await (await request('/destinations', { targetIds })).json()).toEqual({ affected: 1 })
    expect(await store.destinationExists(OTHER)).toBe(true)
    expect(await store.getRevision()).toBe(3)
  })

  it.each([
    ['/guild', { guildId: OTHER }], ['/destinations', { targetIds: [] }],
    ['/webhooks', { targets: [] }], ['/webhook-ids', { webhookIds: [] }],
  ])('returns zero for no-op %s', async (path, body) => {
    expect(await (await request(path as string, body)).json()).toEqual({ affected: 0 })
    expect(await store.getRevision()).toBe(0)
  })

  it.each([
    ['/guild', { guildId: 123 }], ['/guild', { guildId: '01' }], ['/guild', { guildId: '18446744073709551616' }],
    ['/guild', { guildId: GUILD, extra: true }], ['/guild', null],
    ['/destinations', { targetIds: [CHANNEL, null] }], ['/destinations', { targetIds: Array(501).fill(CHANNEL) }],
    ['/destinations', { targetIds: '1' }], ['/webhooks', { targets: [{ targetId: CHANNEL }] }],
    ['/webhooks', { targets: [{ targetId: CHANNEL, expectedWebhookId: WEBHOOK, url: 'secret' }] }],
    ['/webhook-ids', { webhookIds: ['https://discord.com/api/webhooks/123/synthetic-secret'] }],
    ['/webhook-ids', { webhookIds: ['1\n'] }],
  ])('rejects invalid input before DB access: %s %j', async (path, body) => {
    const readDb = vi.fn(() => env.DB)
    const response = await request(path as string, body, { bindings: { ...bindings, get DB() { return readDb() } } })
    expect(response.status).toBe(400)
    expect(readDb).not.toHaveBeenCalled()
  })

  it.each(['{', '{} {}', '[1]', ''])('rejects malformed JSON %j', async (raw) => {
    expect((await request('/guild', undefined, { raw })).status).toBe(400)
  })

  it('enforces the 128 KiB byte boundary with no Content-Length', async () => {
    const raw = JSON.stringify({ targetIds: [] })
    expect((await request('/destinations', undefined, { raw: raw.padEnd(MAX_CLEANUP_BYTES) })).status).toBe(200)
    expect((await request('/destinations', undefined, { raw: raw.padEnd(MAX_CLEANUP_BYTES + 1) })).status).toBe(413)
    expect(await store.getRevision()).toBe(0)
  })

  it.each(['/guild', '/destinations', '/webhooks', '/webhook-ids'])('rolls back %s when revision fails and sanitizes the error', async (path) => {
    await seed()
    const before = await store.loadSnapshot()
    await env.DB.prepare(`CREATE TRIGGER cleanup_fail_revision AFTER UPDATE ON config_meta
      BEGIN SELECT RAISE(ABORT, 'synthetic-webhook-token'); END`).run()
    try {
      const body = path === '/guild' ? { guildId: GUILD } : path === '/destinations' ? { targetIds: [CHANNEL, THREAD] }
        : path === '/webhooks' ? { targets: [{ targetId: CHANNEL, expectedWebhookId: WEBHOOK }] } : { webhookIds: [WEBHOOK] }
      const response = await request(path, body)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'storage_unavailable' })
      expect(await store.loadSnapshot()).toEqual(before)
    } finally {
      await env.DB.prepare('DROP TRIGGER cleanup_fail_revision').run()
    }
  })
})
