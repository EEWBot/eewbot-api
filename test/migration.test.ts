import { applyD1Migrations, createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import type { Destination } from '../src/db/destination-types'
import { app } from '../src/index'
import { MAX_IMPORT_DESTINATIONS } from '../src/routes/migration'
import { resetDb, seedDestination } from './support/fixtures'

const AUD = 'synthetic-migration-aud'
const GUILD = '1234567890123456789'
const CHANNEL = '1234567890123456790'
const THREAD = '1234567890123456791'
const WEBHOOK = '18446744073709551615'
const TOKEN = 'synthetic-webhook-token-0123456789'
const store = new D1DestinationStore(env.DB)

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))
beforeEach(() => resetDb(env.DB))

async function request(body: unknown, options: { aud?: string | null; raw?: string } = {}) {
  const ctx = createExecutionContext()
  Object.defineProperty(ctx, 'access', { value: options.aud === null ? undefined : { aud: options.aud ?? AUD } })
  const response = await app.fetch(
    new Request('https://example.com/internal/v2/migration/destinations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: options.raw ?? JSON.stringify(body),
    }),
    { DB: env.DB, ACCESS_AUD: AUD },
    ctx,
  )
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return response
}

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    targetId: CHANNEL,
    channelId: CHANNEL,
    threadId: null,
    guildId: GUILD,
    eewAlert: true,
    eewPrediction: false,
    eewDecimation: true,
    quakeInfo: true,
    tsunami: false,
    minIntensity: 5,
    lang: 'en_us',
    webhook: { id: WEBHOOK, token: TOKEN },
    ...overrides,
  }
}

const thread = destination({ targetId: THREAD, threadId: THREAD, guildId: null, webhook: null, lang: 'ko_kp' })

describe('POST /internal/v2/migration/destinations', () => {
  it('requires Cloudflare Access before touching the DB', async () => {
    const response = await request({ destinations: [destination()] }, { aud: null })
    expect(response.status).toBe(403)
    expect(await store.getRevision()).toBe(0)
  })

  it('imports a chunk in one revision and exposes it in the snapshot', async () => {
    const response = await request({ destinations: [thread, destination()] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ affected: 2 })
    expect(await store.loadSnapshot()).toEqual({ revision: 1, destinations: [destination(), thread] })
  })

  it('treats an identical re-import as a no-op and overwrites changed rows', async () => {
    await request({ destinations: [destination(), thread] })
    expect(await (await request({ destinations: [destination(), thread] })).json()).toEqual({ affected: 0 })
    expect(await store.getRevision()).toBe(1)

    const changed = destination({ webhook: null, minIntensity: 0, guildId: null })
    expect(await (await request({ destinations: [changed, thread] })).json()).toEqual({ affected: 1 })
    expect(await store.loadSnapshot()).toEqual({ revision: 2, destinations: [changed, thread] })
  })

  it('overwrites a destination registered through Discord', async () => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD })
    expect(await (await request({ destinations: [destination()] })).json()).toEqual({ affected: 1 })
    expect(await store.getDestination(CHANNEL)).toEqual(destination())
  })

  it('accepts an empty chunk without a revision bump', async () => {
    expect(await (await request({ destinations: [] })).json()).toEqual({ affected: 0 })
    expect(await store.getRevision()).toBe(0)
  })

  it('ignores unknown fields', async () => {
    const response = await request({ extra: 1, destinations: [{ ...destination(), webhookUrl: 'ignored' }] })
    expect(await response.json()).toEqual({ affected: 1 })
  })

  it.each([
    ['missing list', {}],
    ['too many', { destinations: Array.from({ length: MAX_IMPORT_DESTINATIONS + 1 }, () => destination()) }],
    ['duplicate target', { destinations: [destination(), destination()] }],
    ['numeric snowflake', { destinations: [{ ...destination(), targetId: 1, channelId: 1 }] }],
    ['channel identity', { destinations: [destination({ channelId: THREAD })] }],
    ['thread identity', { destinations: [destination({ threadId: THREAD })] }],
    ['thread equal to channel', { destinations: [destination({ threadId: CHANNEL })] }],
    ['intensity', { destinations: [{ ...destination(), minIntensity: 10 }] }],
    ['language', { destinations: [{ ...destination(), lang: 'ja_JP' }] }],
    ['flag', { destinations: [{ ...destination(), tsunami: 1 }] }],
    ['missing flag', { destinations: [{ ...destination(), eewAlert: undefined }] }],
    ['webhook token', { destinations: [destination({ webhook: { id: WEBHOOK, token: 'a/b?thread_id=1' } })] }],
    ['short webhook token', { destinations: [destination({ webhook: { id: WEBHOOK, token: 'a'.repeat(19) } })] }],
    ['webhook id', { destinations: [destination({ webhook: { id: '0', token: TOKEN } })] }],
  ])('rejects %s without writing', async (_name, body) => {
    const response = await request(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_request' } })
    expect(await store.loadSnapshot()).toEqual({ revision: 0, destinations: [] })
  })

  it('rejects malformed JSON', async () => {
    const response = await request(undefined, { raw: '{' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_json' } })
  })

  it('imports a full chunk', async () => {
    const destinations = Array.from({ length: MAX_IMPORT_DESTINATIONS }, (_, i) => {
      const id = String(1234567890123456800n + BigInt(i))
      return destination({ targetId: id, channelId: id })
    })
    expect(await (await request({ destinations })).json()).toEqual({ affected: MAX_IMPORT_DESTINATIONS })
    expect((await store.loadSnapshot()).destinations).toHaveLength(MAX_IMPORT_DESTINATIONS)
  })
})
