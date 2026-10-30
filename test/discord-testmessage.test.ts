import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import { TESTMESSAGE_COOLDOWN_MS } from '../src/discord/constants'
import { claimTestMessage } from '../src/discord/testmessage-command'
import { deliveryPlan, senderConfiguration } from '../src/discord/testmessage-delivery'
import type { Target } from '../src/discord/types'
import { LANGUAGES } from '../src/i18n/languages'
import { testMessageText } from '../src/i18n/testmessage'
import {
  ACTOR,
  BOT_TOKEN,
  bindings,
  CHANNEL,
  command,
  DiscordMock,
  execute,
  GUILD,
  HOOK_TOKEN,
  inThread,
  THREAD,
} from './support/discord'
import { resetDb, seedDestination } from './support/fixtures'

const HOOK = '1234567890123456785'
const WEBHOOK = `https://discord.com/api/webhooks/${HOOK}/${HOOK_TOKEN}`
const SENDER = 'https://sender.example.com'
const senderEnv = {
  WEBHOOK_SENDER_URL: SENDER,
  WEBHOOK_SENDER_ACCESS_CLIENT_ID: 'synthetic-access-id',
  WEBHOOK_SENDER_ACCESS_CLIENT_SECRET: 'synthetic-access-secret',
  WEBHOOK_SENDER_AUTH_TOKEN: 'synthetic-sender-secret',
}
const target: Target = { targetId: CHANNEL, guildId: GUILD, channelId: CHANNEL, threadId: null }
const store = new D1DestinationStore(env.DB)
let mock: DiscordMock
let status: number

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
beforeEach(async () => {
  await resetDb(env.DB)
  status = 200
  mock = new DiscordMock().install()
  const respond = () => new Response(status === 200 ? '{}' : HOOK_TOKEN, { status })
  mock.routes.set(`POST /api/webhooks/${HOOK}/${HOOK_TOKEN}`, respond)
  mock.routes.set(`POST /channels/${CHANNEL}/messages`, respond)
  mock.routes.set(`POST /channels/${THREAD}/messages`, respond)
  mock.routes.set(`POST ${SENDER}/api/send`, () => new Response(status === 200 ? 'OK' : '', { status }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function configured(lang: (typeof LANGUAGES)[number]['code'] = 'ja_jp', targetId = CHANNEL) {
  await seedDestination(env.DB, {
    targetId,
    channelId: CHANNEL,
    threadId: targetId === CHANNEL ? null : targetId,
    guildId: GUILD,
    lang,
    webhook: { id: HOOK, token: HOOK_TOKEN },
  })
}
const sends = () => mock.requests.filter((c) => c.method === 'POST')

describe('/testmessage', () => {
  it('lets an ordinary member send through the stored webhook without registering anything', async () => {
    await configured()
    const { ack, reply } = await execute(
      command('testmessage', { member: { permissions: '0', user: { id: ACTOR } } }),
      mock,
    )
    expect(ack).toMatchObject({ type: 5, data: { flags: 64 } })
    expect(sends()).toHaveLength(1)
    expect(sends()[0]?.url.search).toBe('?wait=true')
    expect(reply?.content).toBe(testMessageText('ja_jp', 'success.webhook'))
  })

  it('sends a bot message when no webhook is stored', async () => {
    const { reply } = await execute(command('testmessage'), mock)
    expect(sends()[0]?.headers.get('Authorization')).toBe(`Bot ${BOT_TOKEN}`)
    expect(reply?.content).toBe(testMessageText('ja_jp', 'success.nowebhook'))
    expect(await store.getDestination(CHANNEL)).toBeNull()
  })

  it('requires the bot to send in the thread for a bot message', async () => {
    const { reply } = await execute(
      command('testmessage', { ...inThread, app_permissions: String(1024n | 2048n) }),
      mock,
    )
    expect(sends()).toEqual([])
    expect(reply?.content).toContain(testMessageText('ja_jp', 'error.missingperms'))
  })

  it('posts to a thread through the stored webhook', async () => {
    await configured('ja_jp', THREAD)
    await execute(command('testmessage', inThread), mock)
    expect(sends()[0]?.url.search).toBe(`?thread_id=${THREAD}&wait=true`)
  })

  it('queues through the Webhook Sender when configured', async () => {
    await configured()
    const { reply } = await execute(command('testmessage'), mock, bindings(senderEnv))
    const call = sends()[0]
    expect(call?.headers.get('Authorization')).toBe('Bearer synthetic-sender-secret')
    expect(call?.headers.get('CF-Access-Client-Id')).toBe('synthetic-access-id')
    expect(call?.body).toMatchObject([{ targets: [WEBHOOK] }])
    expect(reply?.content).toBe(testMessageText('ja_jp', 'success.webhooksender'))
  })

  it.each(LANGUAGES)('answers in the stored $code language', async ({ code }) => {
    await configured(code)
    const { reply } = await execute(command('testmessage'), mock)
    expect(reply?.content).toBe(testMessageText(code, 'success.webhook'))
  })

  it.each([
    [403, 'error.missingperms'],
    [404, 'error.unknownwebhook'],
    [429, 'error.ratelimit'],
    [500, 'error.unavailable'],
    [400, 'error.unknown'],
  ] as const)('reports HTTP %s as %s without echoing secrets', async (code, key) => {
    await configured()
    status = code
    const { reply } = await execute(command('testmessage'), mock)
    expect(reply?.content).toContain(testMessageText('ja_jp', key))
    expect(reply?.content).not.toContain(HOOK_TOKEN)
  })

  it('reports a transport failure as an uncertain delivery', async () => {
    await configured()
    mock.routes.set(`POST /api/webhooks/${HOOK}/${HOOK_TOKEN}`, () => {
      throw new Error(HOOK_TOKEN)
    })
    const { reply } = await execute(command('testmessage'), mock)
    expect(reply?.content).toContain(testMessageText('ja_jp', 'error.uncertain'))
  })

  it('enforces a per-target cooldown for every member', async () => {
    await configured()
    await execute(command('testmessage'), mock)
    const { reply } = await execute(
      command('testmessage', { member: { permissions: '0', user: { id: '1234567890123456794' } } }),
      mock,
    )
    expect(sends()).toHaveLength(1)
    expect(reply?.content).toContain(testMessageText('ja_jp', 'error.ratelimit'))
  })
})

describe('claimTestMessage', () => {
  it('grants once per cooldown and again after it', async () => {
    const now = 1_000_000
    expect(await claimTestMessage(env.DB, CHANNEL, now)).toBe(true)
    expect(await claimTestMessage(env.DB, CHANNEL, now + 1)).toBe(false)
    expect(await claimTestMessage(env.DB, THREAD, now + 1)).toBe(true)
    expect(await claimTestMessage(env.DB, CHANNEL, now + TESTMESSAGE_COOLDOWN_MS)).toBe(true)
  })

  it('grants only one of concurrent claims', async () => {
    const results = await Promise.all([1, 2, 3].map(() => claimTestMessage(env.DB, CHANNEL, 5_000_000)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

describe('delivery configuration', () => {
  it('builds webhook URLs on the fixed Discord origin', async () => {
    await configured()
    const d = await store.getDestination(CHANNEL)
    expect(deliveryPlan(bindings(), d, target)).toEqual({ route: 'webhook', webhook: WEBHOOK, sender: null })
    expect(deliveryPlan(bindings(), d, { ...target, targetId: THREAD, threadId: THREAD }).webhook).toBe(
      `${WEBHOOK}?thread_id=${THREAD}`,
    )
    expect(deliveryPlan(bindings(), null, target).route).toBe('nowebhook')
  })

  it.each([
    'file:///sender.example.com',
    'https://user:pass@sender.example.com',
    'https://sender.example.com/api/send',
    'https://sender.example.com?x=1',
    'invalid',
  ])('rejects invalid Sender origin %s', (url) => {
    expect(() => senderConfiguration({ ...senderEnv, WEBHOOK_SENDER_URL: url })).toThrow('configuration')
  })

  it('accepts HTTP with Bearer only, and HTTPS with or without Access', () => {
    const bearer = { WEBHOOK_SENDER_AUTH_TOKEN: 'synthetic-bearer' }
    expect(senderConfiguration({ ...bearer, WEBHOOK_SENDER_URL: 'http://sender.example.test:8080' })).toEqual({
      endpoint: 'http://sender.example.test:8080/api/send',
      access: null,
      authToken: 'synthetic-bearer',
    })
    expect(senderConfiguration({ ...bearer, WEBHOOK_SENDER_URL: `${SENDER}/` })?.access).toBeNull()
    expect(senderConfiguration(senderEnv)?.access).toEqual({
      clientId: 'synthetic-access-id',
      clientSecret: 'synthetic-access-secret',
    })
    expect(senderConfiguration({ ...senderEnv, WEBHOOK_SENDER_URL: '' })).toBeNull()
  })

  it('rejects missing tokens and Access credentials over HTTP', () => {
    expect(() => senderConfiguration({ WEBHOOK_SENDER_URL: SENDER })).toThrow('configuration')
    expect(() => senderConfiguration({ ...senderEnv, WEBHOOK_SENDER_URL: 'http://sender.example.com' })).toThrow(
      'configuration',
    )
  })
})
