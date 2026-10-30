import { expect, it } from 'vitest'
import { apiText } from '../src/i18n/api'
import { coreText, formatCoreText, LANGUAGES } from '../src/i18n/core'
import { CORE_MESSAGES } from '../src/i18n/core-messages'
import { helpText } from '../src/i18n/help'
import { translate } from '../src/i18n/languages'
import { quakeInfoText } from '../src/i18n/quakeinfo'
import { type TestMessageKey, testMessageText } from '../src/i18n/testmessage'

it('defines API-only messages in Japanese and English, leaving other catalogs to fall back', () => {
  const prefix = 'eewbot.scmd.api.'
  const keys = Object.keys(CORE_MESSAGES.ja_jp).filter((key) => key.startsWith(prefix))
  expect(keys.length).toBeGreaterThan(0)
  expect(
    Object.keys(CORE_MESSAGES.en_us)
      .filter((key) => key.startsWith(prefix))
      .sort(),
  ).toEqual([...keys].sort())
  for (const language of ['zh_tw', 'ko_hanja', 'ko_kp'] as const) {
    expect(Object.keys(CORE_MESSAGES[language]).filter((key) => key.startsWith(prefix))).toEqual([])
    for (const key of keys) expect(coreText(language, key)).toBe(coreText('ja_jp', key))
  }
})

it.each(LANGUAGES)('uses Japanese or English Core messages for API-only $code text', ({ code }) => {
  const expectedLanguage = code === 'en_us' ? 'en_us' : 'ja_jp'
  const { invite, ...messages } = apiText(code)
  const { invite: expectedInvite, ...expected } = apiText(expectedLanguage)
  expect(messages).toEqual(expected)
  expect(invite('https://example.test/invite')).toBe(expectedInvite('https://example.test/invite'))
  for (const group of [messages.auth, messages.start, messages.settings, messages.discord]) {
    for (const value of Object.values(group)) expect(value).not.toMatch(/^eewbot\.scmd\./)
  }
  for (const key of ['error.configuration', 'error.unavailable', 'error.uncertain'] as const) {
    expect(testMessageText(code, key)).toBe(coreText(expectedLanguage, `eewbot.scmd.api.testmessage.${key}`))
  }
  for (const key of ['report', 'saved', 'old', 'partial'] as const) {
    expect(quakeInfoText(code)[key]).toBe(coreText(expectedLanguage, `eewbot.scmd.api.quakeinfo.${key}`))
  }
  expect(translate(code, 'count', '2')).toBe(code === 'en_us' ? 'Updated destinations: 2' : '更新した配信先: 2件')
})

it('provides English API guidance and leaves existing third-language shared translations intact', () => {
  expect(apiText('en_us').auth.manageGuildRequired).toBe('Manage Server permission is required.')
  expect(apiText('en_us').settings.invalidValue).toBe('The selected value is invalid.')
  expect(apiText('en_us').invite('https://example.test/')).toBe('EEWBot invite URL: https://example.test/')
  expect(translate('en_us', 'invalid')).toBe('Select exactly one language from the list.')
  expect(coreText('zh_tw', 'eewbot.scmd.testmessage.title')).toBe('測試訊息')
  expect(coreText('ko_kp', 'eewbot.scmd.testmessage.title')).toBe('시험통보문')
})

it.each(LANGUAGES)('resolves shared $code keys exactly, with per-key Japanese fallback', ({ code, name }) => {
  const localized: Readonly<Record<string, string>> = CORE_MESSAGES[code]
  for (const [key, fallback] of Object.entries(CORE_MESSAGES.ja_jp)) {
    expect(coreText(code, key)).toBe(localized[key] ?? fallback)
  }
  expect(translate(code, 'set', name)).toBe(coreText(code, 'eewbot.scmd.lang.set.followup').replace('%s', name))
  expect(translate(code, 'applied', name)).toBe(
    coreText(code, 'eewbot.scmd.lang.applyall.followup').replace('%s', name),
  )
  expect(translate(code, 'applyLabel')).toBe(coreText(code, 'eewbot.scmd.lang.applyall.label'))
  expect(helpText(code, 'linksName')).toBe(coreText(code, 'eewbot.scmd.help.field.links.name'))
  expect(helpText(code, 'links')).toBe(coreText(code, 'eewbot.scmd.help.field.links.value'))
  for (const key of [
    'title',
    'webhook',
    'nowebhook',
    'webhooksender',
    'success.webhook',
    'success.nowebhook',
    'success.webhooksender',
    'error.title',
    'error.missingperms',
    'error.ratelimit',
    'error.unknownwebhook',
  ] satisfies TestMessageKey[]) {
    expect(testMessageText(code, key)).toBe(coreText(code, `eewbot.scmd.testmessage.${key}`))
  }
  expect(testMessageText(code, 'error.unknown')).toBe(
    coreText(code, 'eewbot.scmd.testmessage.error.unknown').replace('%s', ''),
  )
})

it('renders English test-message guidance with actual line breaks', () => {
  expect(testMessageText('en_us', 'nowebhook')).toContain('disabled.\nTo enable')
  expect(testMessageText('en_us', 'success.webhooksender')).toContain('seconds.\nIf you')
  expect(testMessageText('en_us', 'nowebhook')).not.toContain('\\n')
  expect(testMessageText('en_us', 'success.webhooksender')).not.toContain('\\n')
})

it('renders Korean Hanja guidance with actual line breaks', () => {
  for (const key of ['eewbot.scmd.setup.permserror.managewebhooks', 'eewbot.scmd.testmessage.success.webhooksender']) {
    expect(coreText('ko_hanja', key)).toContain('\n')
    expect(coreText('ko_hanja', key)).not.toContain('\\n')
  }
})

it('preserves English help links without editorial changes', () => {
  expect(helpText('en_us', 'links')).toBe(
    '[GitHub](https://github.com/EEWBot/EEWBot)\n[Support Server](https://discord.gg/upt9n86ctG)',
  )
})

it('falls back for missing keys and legacy locales, and returns unknown keys unchanged', () => {
  expect(coreText('zh_tw', 'eewbot.scmd.unregister.confirm')).toBe(coreText('ja_jp', 'eewbot.scmd.unregister.confirm'))
  expect(coreText('ko_kp', 'eewbot.scmd.setup.legal')).toBe(coreText('ja_jp', 'eewbot.scmd.setup.legal'))
  expect(coreText('legacy', 'eewbot.scmd.setup.reply')).toBe(coreText('ja_jp', 'eewbot.scmd.setup.reply'))
  expect(coreText('en_us', 'missing.key')).toBe('missing.key')
  expect(coreText('en_us', 'constructor')).toBe('constructor')
})

it('formats intensity and language placeholders without rewriting values or URL escapes', () => {
  expect(formatCoreText('ja_jp', 'eewbot.scmd.lang.set.followup', '$&%s')).toBe(
    'このチャンネルの言語を**$&%s**に設定しました。',
  )
  expect(formatCoreText('zh_tw', 'eewbot.scmd.setup.sensitivity.followup.unknown', '不明')).toBe(
    '已設定最小通知震度！此頻道之後會發送**所有震度不明**的資訊',
  )
  expect(formatCoreText('ja_jp', 'eewbot.scmd.help.field.links.value')).toBe(
    coreText('ja_jp', 'eewbot.scmd.help.field.links.value'),
  )
})
