import { expect, it } from 'vitest'
import { coreText, formatCoreText, LANGUAGES } from '../src/i18n/core'
import { CORE_MESSAGES } from '../src/i18n/core-messages'
import { helpText } from '../src/i18n/help'
import { translate } from '../src/i18n/languages'
import { type TestMessageKey, testMessageText } from '../src/i18n/testmessage'

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
