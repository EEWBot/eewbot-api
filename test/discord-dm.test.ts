import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import { helpEmbed } from '../src/discord/info-command'
import type { Interaction } from '../src/discord/types'
import { apiText } from '../src/i18n/api'
import { coreText } from '../src/i18n/core'
import { LANGUAGES, translate } from '../src/i18n/languages'
import { setupReply } from '../src/i18n/settings'
import { testMessageText } from '../src/i18n/testmessage'
import { QuakeStore } from '../src/quakeinfo/store'
import { quakeReport } from '../src/quakeinfo/validation'
import {
  ACTOR,
  APP,
  BOT_TOKEN,
  CHANNEL,
  command,
  component,
  DiscordMock,
  DM,
  execute,
  GUILD,
  inDm,
} from './support/discord'
import { resetDb, seedDestination } from './support/fixtures'

const store = new D1DestinationStore(env.DB)
let mock: DiscordMock

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
beforeEach(async () => {
  await resetDb(env.DB)
  mock = new DiscordMock().install()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

it('registers a DM and saves every settings menu without guild permissions or webhooks', async () => {
  const { ack, reply } = await execute(command('setup', inDm), mock)
  expect(ack).toMatchObject({ type: 5, data: { flags: 64 } })
  expect(await store.getDestination(DM)).toMatchObject({
    targetId: DM,
    channelId: DM,
    guildId: null,
    threadId: null,
    webhook: null,
  })
  expect(reply?.content).toBe(setupReply('ja_jp', false))
  expect(reply?.components?.map((row) => row.components[0]?.custom_id)).toEqual(['eew:b', 'eew:m', 'eew:i'])
  for (const [action, values] of [
    ['b', ['eewAlert', 'tsunami']],
    ['m', ['eewDecimation']],
    ['i', ['4']],
  ] as const) {
    const updated = await execute(component(`eew:${action}`, [...values], inDm), mock)
    expect(updated.ack.type).toBe(6)
  }
  expect(await store.getDestination(DM)).toMatchObject({
    eewAlert: true,
    tsunami: true,
    eewDecimation: true,
    minIntensity: 4,
  })
  expect(await store.getRevision()).toBe(4)
  expect(mock.requests).toEqual([])
})

it('confirms, cancels and removes only the current DM registration', async () => {
  await seedDestination(env.DB, { targetId: DM, lang: 'en_us' })
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD })
  await seedDestination(env.DB, { targetId: ACTOR })
  const prompt = await execute(command('unregister', inDm), mock)
  expect(prompt.reply?.content).toBe(coreText('en_us', 'eewbot.scmd.unregister.confirm'))
  const before = await store.loadSnapshot()
  await execute(component('eew:x', undefined, inDm), mock)
  expect(await store.loadSnapshot()).toEqual(before)
  const confirmed = await execute(component('eew:c', undefined, inDm), mock)
  expect(confirmed.reply?.content).toBe(coreText('en_us', 'eewbot.scmd.unregister.done'))
  expect(await store.getDestination(DM)).toBeNull()
  expect((await store.loadSnapshot()).destinations).toHaveLength(2)
})

it('registers and changes the DM language without a guild-wide apply button', async () => {
  const { reply } = await execute(command('lang', inDm), mock)
  expect(await store.getDestination(DM)).toMatchObject({ guildId: null, lang: 'ja_jp' })
  expect(reply?.components?.map((row) => row.components[0]?.custom_id)).toEqual(['eewlang:s'])
  const selected = await execute(component('eewlang:s', ['en_us'], inDm), mock)
  expect((await store.getDestination(DM))?.lang).toBe('en_us')
  expect(selected.reply?.content).toContain('English')
  expect(selected.reply?.components?.map((row) => row.components[0]?.custom_id)).toEqual(['eewlang:s'])
})

it('rejects a guild-wide apply action in a DM without changing any destination', async () => {
  await seedDestination(env.DB, { targetId: DM, lang: 'en_us' })
  await seedDestination(env.DB, { targetId: ACTOR })
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD })
  const before = await store.loadSnapshot()
  const { reply } = await execute(component('eewlang:a', undefined, inDm), mock)
  expect(reply?.content).toBe(translate('en_us', 'invalid'))
  expect(await store.loadSnapshot()).toEqual(before)
})

it('answers help and invite in the saved DM language without mutations or REST', async () => {
  await seedDestination(env.DB, { targetId: DM, lang: 'en_us' })
  const before = await store.loadSnapshot()
  const help = await execute(command('help', inDm), mock)
  expect(help.ack).toMatchObject({ type: 4, data: { embeds: [helpEmbed('en_us')] } })
  const invite = await execute(command('invite', inDm), mock)
  expect(invite.ack.data?.content).toContain(`EEWBot invite URL: https://discord.com/oauth2/authorize?client_id=${APP}`)
  expect(await store.loadSnapshot()).toEqual(before)
  expect(mock.calls).toEqual([])
})

it('posts the latest earthquake report and followups in the DM language', async () => {
  await seedDestination(env.DB, { targetId: DM, lang: 'en_us' })
  await new QuakeStore(env.DB).publish(
    quakeReport({
      eventId: '20260101000000',
      reportType: 'VXSE53',
      reportDateTime: new Date().toISOString(),
      dateTime: null,
      serial: 1,
      infoType: '発表',
      languages: Object.fromEntries(
        LANGUAGES.map(({ code }) => [code, [[{ title: `${code} 0` }], [{ title: `${code} 1` }]]]),
      ),
    }),
  )
  const payload = command('quakeinfo', inDm)
  mock.routes.set(`POST /webhooks/${APP}/${payload.token}`, (call) => {
    expect(call.headers.get('Authorization')).toBeNull()
    expect(call.body).toMatchObject({ embeds: [{ title: 'en_us 1' }] })
    return Response.json({})
  })
  const { ack, reply } = await execute(payload, mock)
  expect(ack.type).toBe(5)
  expect(reply?.embeds).toEqual([{ title: 'en_us 0' }])
  expect(mock.requests).toHaveLength(1)
})

it('sends a bot test message to the DM and enforces its cooldown', async () => {
  await seedDestination(env.DB, { targetId: DM, lang: 'en_us' })
  const before = await store.loadSnapshot()
  mock.routes.set(`POST /channels/${DM}/messages`, (call) => {
    expect(call.headers.get('Authorization')).toBe(`Bot ${BOT_TOKEN}`)
    expect(call.body).toMatchObject({ embeds: [{ description: testMessageText('en_us', 'nowebhook') }] })
    return Response.json({})
  })
  const sent = await execute(command('testmessage', inDm), mock)
  expect(sent.reply?.content).toBe(testMessageText('en_us', 'success.nowebhook'))
  const again = await execute(command('testmessage', inDm), mock)
  expect(again.reply?.content).toContain(testMessageText('en_us', 'error.ratelimit'))
  expect(mock.requests).toHaveLength(1)
  expect(await store.loadSnapshot()).toEqual(before)
})

it.each<Partial<Interaction>>([
  { context: undefined },
  { context: 0 },
  { context: 2 },
  { channel: { type: 3 } },
  { channel: { type: 0 } },
  { channel: { type: 1, parent_id: CHANNEL } },
  { guild_id: GUILD },
  { member: { permissions: '32', user: { id: ACTOR } } },
  { user: undefined },
  { user: { id: 'invalid' } },
  { app_permissions: undefined },
])('rejects malformed or unsupported DM contexts: %j', async (overrides) => {
  const { ack } = await execute(command('setup', { ...inDm, ...overrides }), mock)
  expect(ack).toMatchObject({ type: 4, data: { flags: 64, content: apiText().auth.invalidContext } })
  expect(await store.getRevision()).toBe(0)
  expect(mock.calls).toEqual([])
})

it('rejects a null guild ID in a guild payload before allowing settings access', async () => {
  const payload = {
    ...command('setup'),
    guild_id: null,
    member: { permissions: '0', user: { id: ACTOR } },
  } as unknown as Interaction
  const { ack } = await execute(payload, mock)
  expect(ack).toMatchObject({ type: 4, data: { content: apiText().auth.invalidContext } })
  expect(await store.getRevision()).toBe(0)
  expect(mock.calls).toEqual([])
})

it('does not modify a guild destination with a mismatched DM identity', async () => {
  await seedDestination(env.DB, { targetId: DM, guildId: GUILD, lang: 'en_us' })
  const before = await store.loadSnapshot()
  await execute(command('setup', inDm), mock)
  await execute(component('eew:b', ['eewAlert'], inDm), mock)
  await execute(component('eew:c', undefined, inDm), mock)
  await execute(command('lang', inDm), mock)
  expect(await store.loadSnapshot()).toEqual(before)
  expect(mock.requests).toEqual([])
})
