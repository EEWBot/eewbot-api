import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import { helpEmbed } from '../src/discord/info-command'
import { dispatch } from '../src/discord/router'
import { apiText } from '../src/i18n/api'
import { coreText } from '../src/i18n/core'
import { discordLanguage, interactionLanguage } from '../src/i18n/discord'
import { displayLanguage, LANGUAGES, type LanguageCode, translate } from '../src/i18n/languages'
import { setupFollowup, setupReply } from '../src/i18n/settings'
import { testMessageText } from '../src/i18n/testmessage'
import { QuakeStore } from '../src/quakeinfo/store'
import { quakeReport } from '../src/quakeinfo/validation'
import { ACTOR, bindings, CHANNEL, command, component, DiscordMock, DM, execute, GUILD, inDm } from './support/discord'
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

const locales: { locale: string; saved: LanguageCode; language: LanguageCode }[] = [
  { locale: 'ja', saved: 'en_us', language: 'ja_jp' },
  { locale: 'en-US', saved: 'ja_jp', language: 'en_us' },
  { locale: 'en-GB', saved: 'ja_jp', language: 'en_us' },
  { locale: 'zh-TW', saved: 'en_us', language: 'zh_tw' },
]

it.each(locales)(
  'uses $locale for private setup menus and component replies over $saved',
  async ({ locale, saved, language }) => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: saved })
    const before = await store.loadSnapshot()
    const { ack, reply } = await execute(command('setup', { locale, app_permissions: '3072' }), mock)
    expect(ack).toMatchObject({ type: 5, data: { flags: 64 } })
    expect(reply?.content).toBe(setupReply(language, true))
    expect(reply?.components?.[0]?.components[0]?.placeholder).toBe(
      coreText(language, 'eewbot.scmd.setup.base.placeholder'),
    )
    expect(await store.loadSnapshot()).toEqual(before)

    const changed = await execute(component('eew:b', ['tsunami'], { locale }), mock)
    expect(changed.ack.type).toBe(6)
    expect(changed.reply?.content).toBe(setupFollowup(language, 'b', ['tsunami']))
    expect(changed.reply?.components?.[1]?.components[0]?.placeholder).toBe(
      coreText(language, 'eewbot.scmd.setup.modifier.placeholder'),
    )
    expect(await store.getDestination(CHANNEL)).toMatchObject({ lang: saved, tsunami: true })
  },
)

it('keeps the notification language when opening private setup and language menus in a DM', async () => {
  await seedDestination(env.DB, { targetId: DM, lang: 'ja_jp' })
  const before = await store.loadSnapshot()
  const setup = await execute(command('setup', { ...inDm, locale: 'en-US' }), mock)
  expect(setup.reply?.content).toBe(setupReply('en_us', false))
  const menu = await execute(command('lang', { ...inDm, locale: 'en-US' }), mock)
  expect(menu.reply?.components).toHaveLength(1)
  expect(menu.reply?.components?.[0]?.components[0]?.options?.find((option) => option.default)?.value).toBe('ja_jp')
  expect(await store.loadSnapshot()).toEqual(before)
})

it('uses the current interaction locale for unregister prompts, labels, cancel and confirmation', async () => {
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'ja_jp' })
  const prompt = await execute(command('unregister', { locale: 'en-GB' }), mock)
  expect(prompt.reply?.content).toBe(coreText('en_us', 'eewbot.scmd.unregister.confirm'))
  expect(prompt.reply?.components?.[0]?.components[0]?.label).toBe(
    coreText('en_us', 'eewbot.scmd.unregister.confirm.label'),
  )
  expect(prompt.reply?.components?.[1]?.components[0]?.label).toBe(
    coreText('en_us', 'eewbot.scmd.unregister.cancel.label'),
  )
  const cancelled = await execute(component('eew:x', undefined, { locale: 'en-US' }), mock)
  expect(cancelled.reply?.content).toBe(coreText('en_us', 'eewbot.scmd.unregister.cancelled'))
  expect((await store.getDestination(CHANNEL))?.lang).toBe('ja_jp')
  const confirmed = await execute(component('eew:c', undefined, { locale: 'en-US' }), mock)
  expect(confirmed.reply?.content).toBe(coreText('en_us', 'eewbot.scmd.unregister.done'))
  expect(await store.getDestination(CHANNEL)).toBeNull()
})

it('keeps language selection and guild-wide updates independent of the reply language', async () => {
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'ja_jp' })
  const menu = await execute(command('lang', { locale: 'en-US' }), mock)
  expect(menu.reply?.components?.[1]?.components[0]?.label).toBe(translate('en_us', 'applyLabel'))
  const selected = await execute(component('eewlang:s', ['zh_tw'], { locale: 'en-US' }), mock)
  expect(selected.reply?.content).toBe(translate('en_us', 'set', displayLanguage('zh_tw').name))
  expect(selected.reply?.components?.[1]?.components[0]?.label).toBe(translate('en_us', 'applyLabel'))
  expect(selected.reply?.components?.[0]?.components[0]?.options?.find((option) => option.default)?.value).toBe('zh_tw')
  expect((await store.getDestination(CHANNEL))?.lang).toBe('zh_tw')

  const invalid = await execute(component('eewlang:s', ['invalid'], { locale: 'en-US' }), mock)
  expect(invalid.reply?.content).toBe(translate('en_us', 'invalid'))
  await seedDestination(env.DB, { targetId: ACTOR, guildId: GUILD, lang: 'en_us' })
  const applied = await execute(component('eewlang:a', undefined, { locale: 'en-US' }), mock)
  expect(applied.reply?.content).toBe(
    `${translate('en_us', 'applied', displayLanguage('zh_tw').name)}\n${translate('en_us', 'count', '2')}`,
  )
  expect((await store.getDestination(ACTOR))?.lang).toBe('zh_tw')
})

it('uses existing Traditional Chinese language guidance and falls back per untranslated key', async () => {
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'ja_jp' })
  const selected = await execute(component('eewlang:s', ['en_us'], { locale: 'zh-TW' }), mock)
  expect(selected.reply?.content).toBe(translate('zh_tw', 'set', displayLanguage('en_us').name))
  expect(selected.reply?.content).toContain('此頻道的語言已設定為')
  expect(selected.reply?.components?.[1]?.components[0]?.label).toBe(translate('zh_tw', 'applyLabel'))
  expect((await store.getDestination(CHANNEL))?.lang).toBe('en_us')
  const applied = await execute(component('eewlang:a', undefined, { locale: 'zh-TW' }), mock)
  expect(applied.reply?.content).toBe(
    `${translate('zh_tw', 'applied', displayLanguage('en_us').name)}\n${translate('ja_jp', 'count', '1')}`,
  )
})

it('uses existing Traditional Chinese test results and rate-limit errors over the channel language', async () => {
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'en_us' })
  mock.routes.set(`POST /channels/${CHANNEL}/messages`, (call) => {
    expect(call.body).toMatchObject({ embeds: [{ title: testMessageText('en_us', 'title') }] })
    return Response.json({})
  })
  const success = await execute(command('testmessage', { locale: 'zh-TW' }), mock)
  expect(success.reply?.content).toBe(testMessageText('zh_tw', 'success.nowebhook'))
  expect(success.reply?.content).toBe('已成功完成從 Bot 發送訊息的測試！')
  const cooldown = await execute(command('testmessage', { locale: 'zh-TW' }), mock)
  expect(cooldown.reply?.content).toContain(testMessageText('zh_tw', 'error.ratelimit'))
  expect((await store.getDestination(CHANNEL))?.lang).toBe('en_us')
})

it('answers invites in the client language even when storage is unavailable', async () => {
  const result = await execute(command('invite', { locale: 'en-US' }), mock, bindings({ DB: undefined }))
  expect(result.ack).toMatchObject({ type: 4, data: { flags: 64 } })
  expect(result.ack.data?.content).toMatch(/^EEWBot invite URL: /)
  expect(mock.calls).toEqual([])
})

it('uses the locale only for the private test result and errors, keeping the delivered embed in the channel language', async () => {
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'ja_jp' })
  const before = await store.loadSnapshot()
  mock.routes.set(`POST /channels/${CHANNEL}/messages`, (call) => {
    expect(call.body).toMatchObject({
      embeds: [{ title: testMessageText('ja_jp', 'title'), description: testMessageText('ja_jp', 'nowebhook') }],
    })
    return Response.json({})
  })
  const success = await execute(command('testmessage', { locale: 'en-US' }), mock)
  expect(success.reply?.content).toBe(testMessageText('en_us', 'success.nowebhook'))
  const cooldown = await execute(command('testmessage', { locale: 'en-US' }), mock)
  expect(cooldown.reply?.content).toContain(testMessageText('en_us', 'error.ratelimit'))
  expect(await store.loadSnapshot()).toEqual(before)
})

it('continues using the destination language for public help and earthquake reports', async () => {
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'ja_jp' })
  const help = await execute(command('help', { locale: 'en-US' }), mock)
  expect(help.ack.data?.flags).toBeUndefined()
  expect(help.ack.data?.embeds).toEqual([helpEmbed('ja_jp')])
  await new QuakeStore(env.DB).publish(
    quakeReport({
      eventId: '20260101000000',
      reportType: 'VXSE53',
      reportDateTime: new Date().toISOString(),
      dateTime: null,
      serial: 1,
      infoType: '発表',
      languages: Object.fromEntries(LANGUAGES.map(({ code }) => [code, [[{ title: code }]]])),
    }),
  )
  const report = await execute(command('quakeinfo', { locale: 'en-US' }), mock)
  expect(report.ack.data?.flags).toBeUndefined()
  expect(report.reply?.embeds).toEqual([{ title: 'ja_jp' }])
})

it.each(['setup', 'unregister', 'lang'])('localizes /%s permission failures before storage lookup', async (name) => {
  const result = await execute(
    command(name, { locale: 'en-US', member: { permissions: '0', user: { id: ACTOR } } }),
    mock,
  )
  expect(result.ack.data).toMatchObject({ flags: 64, content: apiText('en_us').auth.manageGuildRequired })
})

it('uses locale for disabled, invalid-context, unsupported and missing-runtime responses', async () => {
  const disabled = await execute(
    command('setup', { locale: 'en-US' }),
    mock,
    bindings({ DISCORD_COMMANDS_ENABLED: 'false' }),
  )
  expect(disabled.ack.data?.content).toBe(apiText('en_us').auth.commandsDisabled)
  const invalid = await execute(command('setup', { locale: 'en-US', channel_id: 'invalid' }), mock)
  expect(invalid.ack.data?.content).toBe(apiText('en_us').auth.invalidContext)
  const unsupported = await execute(command('unknown', { locale: 'en-US' }), mock)
  expect(unsupported.ack.data?.content).toBe(apiText('en_us').unsupported)
  const missingRuntime = await dispatch(command('setup', { locale: 'en-US' }), bindings(), () => {
    throw new Error('No execution context')
  })
  expect(missingRuntime?.data).toMatchObject({ flags: 64, content: apiText('en_us').start.settings })
})

it.each(['setup', 'lang', 'testmessage'])('uses locale for /%s failures when D1 is unavailable', async (name) => {
  const result = await execute(command(name, { locale: 'en-US' }), mock, bindings({ DB: undefined }))
  const expected =
    name === 'setup'
      ? apiText('en_us').settings.failed
      : name === 'lang'
        ? translate('en_us', 'failed')
        : testMessageText('en_us', 'error.configuration')
  expect(result.reply?.content).toContain(expected)
})

it.each([undefined, 'fr', 'en_us', 'constructor', null, {}, 123])(
  'falls back to the destination for unsupported locale %j',
  async (locale) => {
    expect(discordLanguage(locale)).toBeUndefined()
    expect(interactionLanguage(locale, 'en_us')).toBe('en_us')
    expect(interactionLanguage(locale, 'unknown')).toBe('ja_jp')
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'en_us' })
    const result = await execute(command('unregister', { locale: locale as string }), mock)
    expect(result.reply?.content).toBe(coreText('en_us', 'eewbot.scmd.unregister.confirm'))
  },
)

it('retains the configured Korean variant when Discord has no exact Core locale equivalent', () => {
  expect(interactionLanguage('ko', 'ko_hanja')).toBe('ko_hanja')
  expect(interactionLanguage('ko', 'ko_kp')).toBe('ko_kp')
})
