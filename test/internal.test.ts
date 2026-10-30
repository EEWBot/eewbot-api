import { applyD1Migrations, createExecutionContext, SELF, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import type { Destination, DestinationSnapshot, Intensity } from '../src/db/destination-types'
import type { Bindings } from '../src/env'
import { app } from '../src/index'
import { resetDb, seedDestination, updateDestination } from './support/fixtures'

// Synthetic context and credentials, injected only in tests, never from headers.
const AUD = 'synthetic-staging-audience'
const CHANNEL = '1234567890123456790'
const THREAD = '1234567890123456791'
const GUILD = '1234567890123456789'
const WEBHOOK = '1234567890123456792'
const WEBHOOK_TOKEN = 'synthetic-webhook-token-0123456789'
const HOOK = { id: WEBHOOK, token: WEBHOOK_TOKEN }
const PATHS = ['/internal/v2/config/revision', '/internal/v2/config/snapshot'] as const
const SPOOFED_HEADERS = {
  'Cf-Access-Jwt-Assertion': 'synthetic.jwt.secret',
  'CF-Access-Client-Id': 'synthetic-client-id',
  'CF-Access-Client-Secret': 'synthetic-client-secret',
  'X-Authenticated-User': 'synthetic-core',
}
const store = new D1DestinationStore(env.DB)

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  await resetDb(env.DB)
})

afterEach(() => vi.restoreAllMocks())

function spyOnConsole() {
  return (['debug', 'log', 'info', 'warn', 'error'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  )
}

async function request(
  path: string,
  options: {
    accessAud?: string | null
    noContext?: boolean
    bindings?: Bindings
    method?: string
    headers?: HeadersInit
  } = {},
) {
  const ctx = createExecutionContext()
  Object.defineProperty(ctx, 'access', {
    value:
      options.accessAud === null
        ? undefined
        : {
            aud: options.accessAud ?? AUD,
            getIdentity: async () => undefined,
          },
  })
  const response = await app.fetch(
    new Request(`https://api-staging.eewbot.net${path}`, {
      method: options.method ?? 'GET',
      headers: options.headers,
    }),
    options.bindings ?? { DB: env.DB, ACCESS_AUD: AUD },
    options.noContext ? undefined : ctx,
  )
  await waitOnExecutionContext(ctx)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  return response
}

describe('Internal Access boundary', () => {
  it.each([...PATHS, '/internal', '/internal/', '/internal/unknown', '/internal/v1/config/snapshot'])(
    'rejects unauthenticated %s before even reading the DB binding',
    async (path) => {
      const readDb = vi.fn(() => env.DB)
      const response = await request(path, {
        accessAud: null,
        bindings: {
          ACCESS_AUD: AUD,
          get DB() {
            return readDb()
          },
        },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { code: 'access_required' } })
      expect(readDb).not.toHaveBeenCalled()
    },
  )

  it('fails closed when Hono has no ExecutionContext at all', async () => {
    const response = await request(PATHS[1], { noContext: true })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'access_required' } })
  })

  it.each(['other-application', `${AUD} x`, '', AUD.toUpperCase()])(
    'rejects a non-exact context AUD: %j',
    async (accessAud) => {
      const readDb = vi.fn(() => env.DB)
      const response = await request(PATHS[1], {
        accessAud,
        bindings: {
          ACCESS_AUD: AUD,
          get DB() {
            return readDb()
          },
        },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { code: 'access_forbidden' } })
      expect(readDb).not.toHaveBeenCalled()
    },
  )

  it.each([undefined, '', '   '])('fails closed without a configured AUD: %j', async (ACCESS_AUD) => {
    const readDb = vi.fn(() => env.DB)
    const response = await request(PATHS[1], {
      bindings: {
        ACCESS_AUD,
        get DB() {
          return readDb()
        },
      },
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'access_not_configured' } })
    expect(readDb).not.toHaveBeenCalled()
  })

  it.each(Object.entries(SPOOFED_HEADERS))('does not trust the %s header', async (name, value) => {
    const response = await request(PATHS[1], { accessAud: null, headers: { [name]: value } })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'access_required' } })
  })

  it('does not expose a populated snapshot or credentials in unauthenticated errors/logs', async () => {
    await seedDestination(env.DB, { targetId: CHANNEL, webhook: HOOK })
    const logs = spyOnConsole()
    const response = await request(PATHS[1], { accessAud: null, headers: SPOOFED_HEADERS })
    expect(response.status).toBe(403)
    expect(await response.text()).toBe('{"error":{"code":"access_required"}}')
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it('fails closed through the actual Worker entry point with forged headers', async () => {
    // The test Worker has no Access configuration and no ACCESS_AUD binding.
    const response = await SELF.fetch(`https://example.com${PATHS[1]}`, { headers: SPOOFED_HEADERS })
    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: { code: 'access_not_configured' } })
  })

  it.each(['/internal', '/internal/', '/internal/unknown', '/internal/v1/config/snapshot', '/internal/v2/meta'])(
    'returns a non-sensitive 404 for authenticated unknown path %s',
    async (path) => {
      const readDb = vi.fn(() => env.DB)
      const response = await request(path, {
        bindings: {
          ACCESS_AUD: AUD,
          get DB() {
            return readDb()
          },
        },
      })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: 'not_found' } })
      expect(readDb).not.toHaveBeenCalled()
    },
  )
})

describe('Internal configuration JSON contract over migrated local D1', () => {
  it('returns revision zero and an empty snapshot', async () => {
    const revision = await request(PATHS[0])
    expect(revision.status).toBe(200)
    expect(await revision.json()).toEqual({ revision: 0 })
    const snapshot = await request(PATHS[1])
    expect(snapshot.status).toBe(200)
    expect(await snapshot.json()).toEqual({ revision: 0, destinations: [] })
  })

  it('preserves every field, adjacent 64-bit IDs, explicit nulls and webhook credentials', async () => {
    await seedDestination(env.DB, { targetId: CHANNEL })
    await seedDestination(env.DB, {
      targetId: THREAD,
      channelId: CHANNEL,
      threadId: THREAD,
      guildId: GUILD,
      eewAlert: true,
      eewPrediction: false,
      eewDecimation: true,
      quakeInfo: false,
      tsunami: true,
      minIntensity: 4,
      lang: 'en_us',
      webhook: HOOK,
    })
    const logs = spyOnConsole()
    const response = await request(PATHS[1])
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as DestinationSnapshot
    const expected: Destination[] = [
      {
        targetId: CHANNEL,
        channelId: CHANNEL,
        threadId: null,
        guildId: null,
        eewAlert: false,
        eewPrediction: false,
        eewDecimation: false,
        quakeInfo: false,
        tsunami: false,
        minIntensity: 1,
        lang: 'ja_jp',
        webhook: null,
      },
      {
        targetId: THREAD,
        channelId: CHANNEL,
        threadId: THREAD,
        guildId: GUILD,
        eewAlert: true,
        eewPrediction: false,
        eewDecimation: true,
        quakeInfo: false,
        tsunami: true,
        minIntensity: 4,
        lang: 'en_us',
        webhook: HOOK,
      },
    ]
    expect(snapshot).toEqual({ revision: 2, destinations: expected })
    const revision = await request(PATHS[0])
    expect(await revision.json()).toEqual({ revision: snapshot.revision })
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as Intensity[])(
    'preserves Java intensity code %i and every flag as a JSON boolean',
    async (minIntensity) => {
      await seedDestination(env.DB, {
        targetId: CHANNEL,
        minIntensity,
        eewAlert: false,
        eewPrediction: true,
        eewDecimation: false,
        quakeInfo: true,
        tsunami: false,
      })
      const snapshot = (await (await request(PATHS[1])).json()) as DestinationSnapshot
      expect(snapshot.destinations[0]).toMatchObject({
        minIntensity,
        eewAlert: false,
        eewPrediction: true,
        eewDecimation: false,
        quakeInfo: true,
        tsunami: false,
      })
    },
  )

  it('returns a coherent updated snapshot and monotonic revision after store mutations', async () => {
    await store.insertIfAbsent({ targetId: CHANNEL, channelId: CHANNEL, guildId: GUILD, threadId: null })
    const before = (await (await request(PATHS[1])).json()) as DestinationSnapshot
    expect(before.revision).toBe(1)
    await updateDestination(env.DB, CHANNEL, { lang: 'en_us' })
    await updateDestination(env.DB, CHANNEL, { webhook_id: WEBHOOK, webhook_token: WEBHOOK_TOKEN })
    const after = (await (await request(PATHS[1])).json()) as DestinationSnapshot
    expect(after.revision).toBe(3)
    expect(after.destinations[0]).toMatchObject({ lang: 'en_us', webhook: HOOK })
    expect(await (await request(PATHS[0])).json()).toEqual({ revision: after.revision })
    await store.removeDestinations([CHANNEL])
    expect(await (await request(PATHS[1])).json()).toEqual({ revision: 4, destinations: [] })
  })

  it.each(PATHS)('returns a sanitized 503 for missing DB on %s', async (path) => {
    const response = await request(path, { bindings: { ACCESS_AUD: AUD } })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'storage_unavailable' } })
  })

  it('serves HEAD on GET routes without a body', async () => {
    const response = await request(PATHS[0], { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it.each(PATHS)('does not expose or log failing D1 details on %s', async (path) => {
    const logs = spyOnConsole()
    const prepare = vi.fn(() => {
      throw new Error(`SELECT * FROM destinations; ${WEBHOOK_TOKEN}; synthetic-client-secret`)
    })
    const response = await request(path, {
      bindings: { ACCESS_AUD: AUD, DB: { prepare } as unknown as Bindings['DB'] },
      headers: SPOOFED_HEADERS,
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'storage_unavailable' } })
    expect(prepare).toHaveBeenCalledOnce()
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('answers authenticated %s with 404 and no writes', async (method) => {
    await seedDestination(env.DB, { targetId: CHANNEL })
    const before = await store.loadSnapshot()
    for (const path of PATHS) expect((await request(path, { method })).status).toBe(404)
    expect(await store.loadSnapshot()).toEqual(before)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])(
    'authenticates before rejecting method %s',
    async (method) => {
      const response = await request(PATHS[1], { accessAud: null, method, headers: SPOOFED_HEADERS })
      expect(response.status).toBe(403)
    },
  )

  it('maps an unexpected (non-storage) failure to a logged 500 without details', async () => {
    const logs = spyOnConsole()
    const DB = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [{ revision: 1, snapshot_id: 'x', message_index: 0, embeds_json: `{bug ${WEBHOOK_TOKEN}` }],
          }),
        }),
      }),
    }
    const response = await request('/internal/v2/quakeinfo/latest', {
      bindings: { ACCESS_AUD: AUD, DB: DB as unknown as Bindings['DB'] },
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: { code: 'internal_error' } })
    const output = logs.flatMap((log) => log.mock.calls.flat()).join('\n')
    expect(output).toContain('internal_unhandled_error')
    expect(output).not.toContain(WEBHOOK_TOKEN)
  })
})
