import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import { claimTestMessage } from '../src/discord/testmessage-command'
import { deliveryPlan, senderConfiguration } from '../src/discord/testmessage-delivery'
import type { Interaction, Target } from '../src/discord/types'
import type { Bindings } from '../src/env'
import { LANGUAGES, type LanguageCode } from '../src/i18n/languages'
import { testMessageText } from '../src/i18n/testmessage'
import { app } from '../src/index'
import { resetDb, seedDestination } from './support/fixtures'

const APP = '1234567890123456780',
  GUILD = '1234567890123456781',
  CHANNEL = '1234567890123456782'
const THREAD = '1234567890123456783',
  USER = '1234567890123456784',
  HOOK = '1234567890123456785'
const GUILD_B = '2234567890123456781',
  CHANNEL_B = '2234567890123456782'
const TOKEN = 'synthetic-webhook-secret-token',
  BOT = 'synthetic-bot-secret'
const WEBHOOK = `https://discord.com/api/webhooks/${HOOK}/${TOKEN}`
const SENDER = 'https://sender.example.com'
const senderEnv = {
  WEBHOOK_SENDER_URL: SENDER,
  WEBHOOK_SENDER_ACCESS_CLIENT_ID: 'synthetic-access-id',
  WEBHOOK_SENDER_ACCESS_CLIENT_SECRET: 'synthetic-access-secret',
  WEBHOOK_SENDER_AUTH_TOKEN: 'synthetic-sender-secret',
}
const PERMS = (1024n | 2048n | (1n << 38n)).toString()
const target: Target = { targetId: CHANNEL, guildId: GUILD, channelId: CHANNEL, threadId: null }
const store = new D1DestinationStore(env.DB)
type Call = { url: URL; method: string; headers: Headers; body: any }
let key: CryptoKey, publicKey: string, bindings: Bindings, calls: Call[], replies: Map<string, any>
let channel: Record<string, unknown>, roles: string, fault: (() => Response | Promise<Response>) | undefined
let sequence = 0

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  key = pair.privateKey
  publicKey = hex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
})
beforeEach(async () => {
  await resetDb(env.DB)
  bindings = {
    DB: env.DB,
    DISCORD_PUBLIC_KEY: publicKey,
    DISCORD_COMMANDS_ENABLED: 'true',
    DISCORD_APPLICATION_ID: APP,
    DISCORD_BOT_TOKEN: BOT,
  }
  calls = []
  replies = new Map()
  channel = {}
  roles = PERMS
  fault = undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)),
        method = init?.method ?? 'GET',
        headers = new Headers(init?.headers)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, headers, body })
      expect(init?.redirect).toBe('manual')
      expect(init?.signal).toBeDefined()
      if (url.origin === 'http://sender.example.test:8080') {
        expect(url.pathname).toBe('/api/send')
        expect(method).toBe('POST')
        expect(headers.get('Authorization')).toBe('Bearer synthetic-legacy-bearer')
        expect(headers.has('CF-Access-Client-Id')).toBe(false)
        expect(headers.has('CF-Access-Client-Secret')).toBe(false)
        return new Response('OK')
      }
      if (url.origin === SENDER) {
        expect(url.pathname).toBe('/api/send')
        expect(method).toBe('POST')
        expect(headers.get('Authorization')).toBe(`Bearer ${senderEnv.WEBHOOK_SENDER_AUTH_TOKEN}`)
        expect(headers.get('CF-Access-Client-Id')).toBe(senderEnv.WEBHOOK_SENDER_ACCESS_CLIENT_ID)
        expect(headers.get('CF-Access-Client-Secret')).toBe(senderEnv.WEBHOOK_SENDER_ACCESS_CLIENT_SECRET)
        return fault ? fault() : new Response('OK')
      }
      expect(url.origin).toBe('https://discord.com')
      expect(headers.has('CF-Access-Client-Id')).toBe(false)
      expect(headers.has('CF-Access-Client-Secret')).toBe(false)
      if (method === 'PATCH') {
        expect(headers.has('Authorization')).toBe(false)
        replies.set(url.pathname.split('/')[5], body)
        return Response.json({ id: CHANNEL })
      }
      if (method === 'POST') {
        expect(headers.get('Authorization')).toBe(url.pathname.startsWith('/api/webhooks/') ? null : `Bot ${BOT}`)
        return fault ? fault() : Response.json({ id: CHANNEL })
      }
      expect(headers.get('Authorization')).toBe(`Bot ${BOT}`)
      const path = url.pathname.replace('/api/v10', '')
      if (path === '/oauth2/applications/@me') return Response.json({ id: APP })
      if (path === `/channels/${CHANNEL_B}`)
        return Response.json({ id: CHANNEL_B, guild_id: GUILD_B, type: 0, permission_overwrites: [] })
      if (path === `/guilds/${GUILD_B}/members/${APP}`) return Response.json({ user: { id: APP }, roles: [] })
      if (path === `/guilds/${GUILD_B}/roles`) return Response.json([{ id: GUILD_B, permissions: roles }])
      if (path === `/channels/${CHANNEL}`)
        return Response.json({ id: CHANNEL, guild_id: GUILD, type: 0, permission_overwrites: [], ...channel })
      if (path === `/channels/${THREAD}`)
        return Response.json({ id: THREAD, guild_id: GUILD, type: 11, parent_id: CHANNEL })
      if (path === `/guilds/${GUILD}/members/${APP}`) return Response.json({ user: { id: APP }, roles: [] })
      if (path === `/guilds/${GUILD}/roles`) return Response.json([{ id: GUILD, permissions: roles }])
      throw new Error('unexpected synthetic request')
    }),
  )
})
afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS fail_testmessage').run()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
function hex(b: Uint8Array) {
  return Array.from(b)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
}
function interaction(overrides: Partial<Interaction> = {}): Interaction {
  sequence++
  return {
    type: 2,
    id: String(1234567890123460000n + BigInt(sequence)),
    application_id: APP,
    guild_id: GUILD,
    channel_id: CHANNEL,
    context: 0,
    authorizing_integration_owners: { '0': GUILD },
    token: `synthetic-interaction-${sequence}`,
    member: { user: { id: USER }, permissions: '0' },
    app_permissions: PERMS,
    data: { name: 'testmessage' },
    ...overrides,
  }
}
async function execute(i = interaction(), settings = bindings, bad = false) {
  const body = JSON.stringify(i),
    timestamp = String(Math.floor(Date.now() / 1000))
  const signature = hex(
    new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(timestamp + body))),
  )
  const ctx = createExecutionContext()
  const response = await app.fetch(
    new Request('https://local/interactions', {
      method: 'POST',
      body,
      headers: { 'X-Signature-Ed25519': bad ? '0'.repeat(128) : signature, 'X-Signature-Timestamp': timestamp },
    }),
    settings,
    ctx,
  )
  const ack = response.status === 200 ? ((await response.json()) as any) : null
  await waitOnExecutionContext(ctx)
  return { status: response.status, ack, reply: replies.get(i.token!) }
}
function posts() {
  return calls.filter((c) => c.method === 'POST')
}
async function configured(thread = false, lang: LanguageCode = 'ja_jp') {
  await seedDestination(env.DB, {
    ...target,
    targetId: thread ? THREAD : CHANNEL,
    threadId: thread ? THREAD : null,
    lang,
    webhook: { id: HOOK, token: TOKEN },
  })
}
async function expire(seconds = 601) {
  await env.DB.prepare('UPDATE discord_testmessage_runs SET issued_at = issued_at - ?')
    .bind(seconds * 1000)
    .run()
}
const claim = (id: string, actor: string, t: Target) => claimTestMessage(env.DB, id, actor, t)

it('accepts an ordinary member, defers ephemerally, posts a Japanese Bot embed, and never registers a destination', async () => {
  const before = await store.loadSnapshot(),
    result = await execute()
  expect(result.ack).toEqual({ type: 5, data: { flags: 64, allowed_mentions: { parse: [] } } })
  expect(posts()).toHaveLength(1)
  expect(posts()[0].url.pathname).toBe(`/api/v10/channels/${CHANNEL}/messages`)
  expect(posts()[0].body).toEqual({
    embeds: [
      { title: testMessageText('ja_jp', 'title'), description: testMessageText('ja_jp', 'nowebhook'), color: 7506394 },
    ],
    allowed_mentions: { parse: [] },
  })
  expect(result.reply.content).toBe(testMessageText('ja_jp', 'success.nowebhook'))
  expect(result.reply.allowed_mentions).toEqual({ parse: [] })
  expect(await store.loadSnapshot()).toEqual(before)
})
it.each(['webhook', 'webhooksender', 'nowebhook'])(
  'uses %s with a registered destination without snapshot changes',
  async (route) => {
    if (route === 'nowebhook') await store.insertDestinationIfAbsent(target)
    else await configured()
    const before = await store.loadSnapshot()
    const { reply } = await execute(interaction(), route === 'webhooksender' ? { ...bindings, ...senderEnv } : bindings)
    expect(posts()).toHaveLength(1)
    const sent = posts()[0]
    if (route === 'webhooksender') {
      expect(sent.body).toEqual([
        {
          targets: [WEBHOOK],
          body: {
            embeds: [
              {
                title: testMessageText('ja_jp', 'title'),
                description: testMessageText('ja_jp', route),
                color: 7506394,
              },
            ],
            allowed_mentions: { parse: [] },
          },
          retry_limit: 10,
        },
      ])
      expect(reply.content).toContain('配信を予約')
      expect(reply.content).not.toContain('成功')
    } else if (route === 'webhook') expect(sent.url.search).toBe('?wait=true')
    expect(reply.content).toBe(testMessageText('ja_jp', `success.${route}` as any))
    expect(await store.loadSnapshot()).toEqual(before)
  },
)
it.each(['webhook', 'webhooksender', 'nowebhook'])('sends %s to the verified Thread', async (route) => {
  if (route !== 'nowebhook') await configured(true)
  // Parent SEND_MESSAGES is deliberately absent. Threads require SEND_IN_THREADS.
  roles = (1024n | (1n << 38n)).toString()
  const { reply } = await execute(
    interaction({ channel_id: THREAD, app_permissions: roles }),
    route === 'webhooksender' ? { ...bindings, ...senderEnv } : bindings,
  )
  expect(reply.content).toBe(testMessageText('ja_jp', `success.${route}` as any))
  const sent = posts()[0]
  if (route === 'nowebhook') expect(sent.url.pathname).toBe(`/api/v10/channels/${THREAD}/messages`)
  else if (route === 'webhook') expect(sent.url.search).toBe(`?thread_id=${THREAD}&wait=true`)
  else expect(sent.body[0].targets).toEqual([`${WEBHOOK}?thread_id=${THREAD}`])
})
it.each(LANGUAGES)('uses the saved $code language for embeds and replies', async ({ code }) => {
  await configured(false, code)
  const { reply } = await execute()
  expect(posts()[0].body.embeds[0].title).toBe(testMessageText(code, 'title'))
  expect(posts()[0].body.embeds[0].description).toBe(testMessageText(code, 'webhook'))
  expect(reply.content).toBe(testMessageText(code, 'success.webhook'))
})
it.each([
  { application_id: HOOK },
  { guild_id: HOOK },
  { context: 1 },
  { member: undefined },
  { authorizing_integration_owners: { '0': GUILD, '1': USER } },
  { data: { name: 'testmessage', options: [{ name: 'channel', value: HOOK }] } },
])('rejects invalid execution context %j before any REST', async (overrides) => {
  const result = await execute(interaction(overrides))
  expect(result.ack.type).toBe(4)
  expect(result.ack.data.flags).toBe(64)
  expect(calls).toEqual([])
})
it('rejects bad signatures before storage access', async () => {
  const read = vi.fn(() => env.DB)
  expect(
    (
      await execute(
        interaction(),
        {
          ...bindings,
          get DB() {
            return read()
          },
        },
        true,
      )
    ).status,
  ).toBe(401)
  expect(read).not.toHaveBeenCalled()
  expect(calls).toEqual([])
})
it('honors the staging commands switch', async () => {
  expect((await execute(interaction(), { ...bindings, DISCORD_COMMANDS_ENABLED: 'false' })).ack.type).toBe(4)
  expect(calls).toEqual([])
})
it.each([{ guild_id: HOOK }, { type: 15 }, { id: HOOK }])('rejects Discord channel mismatch %j', async (override) => {
  channel = override
  await execute()
  expect(posts()).toEqual([])
})
it('rejects a saved destination belonging to another guild', async () => {
  await seedDestination(env.DB, { ...target, guildId: HOOK, webhook: { id: HOOK, token: TOKEN } })
  await execute()
  expect(posts()).toEqual([])
})
it.each(['0', '1024', '2048'])(
  'checks Bot permissions independently of the invoking member: %s',
  async (permission) => {
    roles = permission
    expect((await execute()).reply.content).toContain(testMessageText('ja_jp', 'error.missingperms'))
    expect(posts()).toEqual([])
  },
)
it('requires signed app permissions for a Bot send', async () => {
  await execute(interaction({ app_permissions: '0' }))
  expect(posts()).toEqual([])
})
it('requires thread send permission rather than parent send permission', async () => {
  roles = '3072'
  await execute(interaction({ channel_id: THREAD }))
  expect(posts()).toEqual([])
})
it.each([
  'WEBHOOK_SENDER_ACCESS_CLIENT_ID',
  'WEBHOOK_SENDER_ACCESS_CLIENT_SECRET',
  'WEBHOOK_SENDER_AUTH_TOKEN',
] as const)('fails closed when %s is absent', async (missing) => {
  await configured()
  const settings = { ...bindings, ...senderEnv }
  delete settings[missing]
  expect((await execute(interaction(), settings)).reply.content).toContain(
    testMessageText('ja_jp', 'error.configuration'),
  )
  expect(posts()).toEqual([])
})
it('fails closed for URL-only configuration without reusing Internal Access', async () => {
  await configured()
  await execute(interaction(), { ...bindings, WEBHOOK_SENDER_URL: SENDER, ACCESS_AUD: 'not-a-sender-credential' })
  expect(posts()).toEqual([])
})
it.each([
  'file:///sender.example.com',
  'https://sender.example.com:invalid',
  'https://user:pass@sender.example.com',
  'https://sender.example.com/api/send',
  'https://sender.example.com?x=1',
  'https://sender.example.com#fragment',
  'https://sender.example.com?',
  'https://sender.example.com#',
  'https://sender.example.com\\evil',
  'invalid',
  ' ',
])('rejects invalid Sender origin %s', (url) =>
  expect(() => senderConfiguration({ ...senderEnv, WEBHOOK_SENDER_URL: url })).toThrow(),
)
it('allows a canonical HTTPS origin with a trailing slash and uses only /api/send', () => {
  expect(senderConfiguration({ ...senderEnv, WEBHOOK_SENDER_URL: `${SENDER}/` })?.endpoint).toBe(`${SENDER}/api/send`)
})
it('disables Sender when URL is absent even if Sender secrets exist', () => {
  expect(senderConfiguration({ ...senderEnv, WEBHOOK_SENDER_URL: '' })).toBeNull()
})
const legacyEnv = {
  WEBHOOK_SENDER_URL: 'http://sender.example.test:8080',
  WEBHOOK_SENDER_AUTH_TOKEN: 'synthetic-legacy-bearer',
}
it('allows a configured HTTP origin with Bearer-only auth and no permission flag', () => {
  expect(senderConfiguration(legacyEnv)).toEqual({
    endpoint: 'http://sender.example.test:8080/api/send',
    access: null,
    authToken: 'synthetic-legacy-bearer',
  })
})
it('sends only Bearer auth to the configured HTTP endpoint', async () => {
  await configured()
  const { reply } = await execute(interaction(), { ...bindings, ...legacyEnv })
  expect(reply.content).toContain('配信を予約')
  expect(posts()).toHaveLength(1)
  expect(posts()[0].body[0].targets).toEqual([WEBHOOK])
})
it.each([
  { WEBHOOK_SENDER_URL: 'ftp://sender.example.com' },
  { WEBHOOK_SENDER_AUTH_TOKEN: undefined },
  { WEBHOOK_SENDER_ACCESS_CLIENT_ID: 'synthetic-access-id' },
  { WEBHOOK_SENDER_ACCESS_CLIENT_SECRET: 'synthetic-access-secret' },
  {
    WEBHOOK_SENDER_ACCESS_CLIENT_ID: 'synthetic-access-id',
    WEBHOOK_SENDER_ACCESS_CLIENT_SECRET: 'synthetic-access-secret',
  },
])('rejects an invalid or Access-credentialed HTTP configuration %j', (override) => {
  expect(() => senderConfiguration({ ...legacyEnv, ...override })).toThrow('configuration')
})
it.each(['http://sender.example.com', 'http://sender.example.com:8080'])(
  'supports any configured HTTP origin without staging pins: %s',
  (origin) => {
    expect(senderConfiguration({ ...legacyEnv, WEBHOOK_SENDER_URL: origin })?.endpoint).toBe(`${origin}/api/send`)
  },
)
it('supports HTTPS with Bearer-only auth when Access is not deployed', () => {
  expect(
    senderConfiguration({ WEBHOOK_SENDER_URL: SENDER, WEBHOOK_SENDER_AUTH_TOKEN: 'synthetic-bearer' })?.access,
  ).toBeNull()
})
it('builds the webhook URL from stored credentials on the fixed Discord origin', async () => {
  await configured()
  const d = (await store.getDestination(CHANNEL))!
  expect(deliveryPlan(bindings, d, target)).toEqual({ route: 'webhook', webhook: WEBHOOK, sender: null })
  expect(
    deliveryPlan(bindings, { ...d, threadId: THREAD }, { ...target, targetId: THREAD, threadId: THREAD }).webhook,
  ).toBe(`${WEBHOOK}?thread_id=${THREAD}`)
  expect(deliveryPlan(bindings, { ...d, webhook: null }, target).route).toBe('nowebhook')
})
it.each(['short', `${TOKEN}/x`, `${TOKEN}?wait=true`, `${TOKEN}#f`, `${TOKEN}\n`, 'x'.repeat(257)])(
  'rejects a malformed stored token %j without echoing credentials',
  async (token) => {
    await configured()
    const d = (await store.getDestination(CHANNEL))!
    const error = (() => {
      try {
        deliveryPlan(bindings, { ...d, webhook: { id: HOOK, token } }, target)
      } catch (e) {
        return e
      }
    })()
    expect(String(error)).toContain('configuration')
    expect(String(error)).not.toContain(token)
  },
)
it('does not send when an invalid stored webhook is read', async () => {
  await configured()
  await env.DB.prepare("UPDATE destinations SET webhook_token = 'bad token'").run()
  await execute()
  expect(posts()).toEqual([])
})

const failures = [301, 302, 307, 308, 400, 401, 403, 404, 429, 500, 502, 503]
for (const route of ['webhook', 'webhooksender', 'nowebhook'] as const) {
  it.each(failures)(
    `${route} handles HTTP %s once, without token leaks, fallback or configuration writes`,
    async (status) => {
      if (route !== 'nowebhook') await configured()
      const before = await store.loadSnapshot()
      const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
      fault = () =>
        new Response(TOKEN + BOT + senderEnv.WEBHOOK_SENDER_AUTH_TOKEN, {
          status,
          headers: { Location: 'https://evil.example/' },
        })
      const { reply } = await execute(
        interaction(),
        route === 'webhooksender' ? { ...bindings, ...senderEnv } : bindings,
      )
      const code =
        route === 'webhooksender' && [401, 403].includes(status)
          ? 'configuration'
          : status === 429
            ? 'ratelimit'
            : status >= 500
              ? 'unavailable'
              : route !== 'webhooksender' && status === 403
                ? 'missingperms'
                : route === 'webhook' && status === 404
                  ? 'unknownwebhook'
                  : 'unknown'
      expect(reply.content).toContain(testMessageText('ja_jp', `error.${code}`))
      expect(JSON.stringify(reply) + JSON.stringify(log.mock.calls)).not.toMatch(/synthetic-.*secret/)
      expect(posts()).toHaveLength(1)
      expect(await store.loadSnapshot()).toEqual(before)
      if (route === 'webhook' && status === 404) expect(reply.content).toContain('/setup')
    },
  )
  it.each([200, 204])(`${route} interprets HTTP %s according to its delivery contract`, async (status) => {
    if (route !== 'nowebhook') await configured()
    fault = () => new Response(status === 204 ? null : route === 'webhooksender' ? 'OK' : '{}', { status })
    const { reply } = await execute(interaction(), route === 'webhooksender' ? { ...bindings, ...senderEnv } : bindings)
    expect(reply.content).toContain(
      testMessageText('ja_jp', route === 'webhooksender' && status === 204 ? 'error.unknown' : `success.${route}`),
    )
  })
  it(`${route} drops connection errors and never repeats an ambiguous send on replay`, async () => {
    if (route !== 'nowebhook') await configured()
    fault = () => {
      throw new Error(WEBHOOK + senderEnv.WEBHOOK_SENDER_AUTH_TOKEN)
    }
    const i = interaction(),
      settings = route === 'webhooksender' ? { ...bindings, ...senderEnv } : bindings
    expect((await execute(i, settings)).reply.content).toContain(testMessageText('ja_jp', 'error.uncertain'))
    await execute(i, settings)
    expect(posts()).toHaveLength(1)
  })
  it(`${route} bounds a stalled response body`, async () => {
    if (route !== 'nowebhook') await configured()
    fault = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('O'))
          },
        }),
      )
    expect(
      (await execute(interaction(), route === 'webhooksender' ? { ...bindings, ...senderEnv } : bindings)).reply
        .content,
    ).toContain(testMessageText('ja_jp', 'error.uncertain'))
    expect(posts()).toHaveLength(1)
  })
  it.each([true, false])(`${route} bounds response size (length header: %s)`, async (header) => {
    if (route !== 'nowebhook') await configured()
    fault = () => new Response('x'.repeat(65537), { headers: header ? { 'Content-Length': '65537' } : {} })
    expect(
      (await execute(interaction(), route === 'webhooksender' ? { ...bindings, ...senderEnv } : bindings)).reply
        .content,
    ).toContain(testMessageText('ja_jp', 'error.unknown'))
    expect(posts()).toHaveLength(1)
  })
}
it('does not claim queue acceptance for an HTTP 200 error body', async () => {
  await configured()
  fault = () => new Response('queue failed')
  expect((await execute(interaction(), { ...bindings, ...senderEnv })).reply.content).toContain(
    testMessageText('ja_jp', 'error.unknown'),
  )
})
it('prevents identical signed interaction replay from sending twice', async () => {
  const i = interaction()
  await Promise.all([execute(i), execute(i)])
  expect(posts()).toHaveLength(1)
})
it('rejects channel cooldown before sending, even for another actor', async () => {
  await execute()
  const i = interaction({ member: { user: { id: HOOK }, permissions: '0' } })
  expect((await execute(i)).reply.content).toContain(testMessageText('ja_jp', 'error.ratelimit'))
  expect(posts()).toHaveLength(1)
})
it('rejects actor cooldown on another thread', async () => {
  await execute()
  expect((await execute(interaction({ channel_id: THREAD }))).reply.content).toContain(
    testMessageText('ja_jp', 'error.ratelimit'),
  )
  expect(posts()).toHaveLength(1)
})
it('allows a new interaction after both cooldowns pass', async () => {
  await execute()
  await expire(61)
  await execute()
  expect(posts()).toHaveLength(2)
})
it('keeps replay receipts even when send cooldowns have passed', async () => {
  const i = interaction()
  await execute(i)
  await expire()
  await execute(i)
  expect(posts()).toHaveLength(1)
})
it('enforces Guild sliding-window limit across separate state instances', async () => {
  for (let n = 0; n < 10; n++)
    expect(await claim(String(1000 + n), String(2000 + n), { ...target, targetId: String(3000 + n) })).toBe('granted')
  expect(await claim('10000', '20000', { ...target, targetId: '30000' })).toBe('limited')
  await expire()
  expect(await claim('10001', '20000', { ...target, targetId: '30000' })).toBe('granted')
  expect(await store.getRevision()).toBe(0)
})
it.each(['channel', 'actor', 'guild'])('atomically enforces %s limits for concurrent Workers', async (gate) => {
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, n) =>
      claim(String(1000 + n), gate === 'actor' ? USER : String(2000 + n), {
        ...target,
        targetId: gate === 'channel' ? CHANNEL : String(3000 + n),
      }),
    ),
  )
  expect(results.filter((r) => r === 'granted')).toHaveLength(gate === 'guild' ? 10 : 1)
  expect(await store.getRevision()).toBe(0)
})
it('fails closed and rolls back receipts when the reservation cannot commit', async () => {
  await env.DB.prepare(`CREATE TRIGGER fail_testmessage BEFORE INSERT ON discord_testmessage_runs
    BEGIN SELECT RAISE(ABORT, 'synthetic-storage-secret'); END`).run()
  await execute()
  expect(posts()).toEqual([])
  expect(await env.DB.prepare('SELECT count(*) AS n FROM interaction_receipts').first('n')).toBe(0)
})

it('allows signed testmessage in a second guild without reusing another guild webhook', async () => {
  await configured()
  const a = await store.getDestination(CHANNEL)
  await execute(
    interaction({
      guild_id: GUILD_B,
      channel_id: CHANNEL_B,
      authorizing_integration_owners: { '0': GUILD_B },
      member: { permissions: '0', user: { id: HOOK } },
    }),
  )
  expect(posts()).toHaveLength(1)
  expect(posts()[0].url.pathname).toBe(`/api/v10/channels/${CHANNEL_B}/messages`)
  expect(JSON.stringify(posts()[0].body)).not.toContain(TOKEN)
  expect(await store.getDestination(CHANNEL)).toEqual(a)
})
it('keeps guild rate limits independent while preserving the shared actor cooldown', async () => {
  for (let i = 0; i < 10; i++) {
    const id = String(3234567890123456700n + BigInt(i))
    expect(await claim(id, id, { ...target, targetId: id })).toBe('granted')
  }
  const id = '4234567890123456700'
  expect(await claim(id, id, { ...target, targetId: id })).toBe('limited')
  const b = { targetId: CHANNEL_B, channelId: CHANNEL_B, threadId: null, guildId: GUILD_B }
  expect(await claim('4234567890123456701', USER, b)).toBe('granted')
  expect(await claim('4234567890123456702', USER, target)).toBe('limited')
})
