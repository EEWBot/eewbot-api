import { formatCoreText } from './core'

export { displayLanguage, isLanguageCode, LANGUAGES, type LanguageCode } from './core'

const keys = {
  set: 'eewbot.scmd.lang.set.followup',
  applyLabel: 'eewbot.scmd.lang.applyall.label',
  applied: 'eewbot.scmd.lang.applyall.followup',
  count: 'eewbot.scmd.lang.applyall.followup.count',
  stale: 'eewbot.scmd.lang.error.stale',
  invalid: 'eewbot.scmd.lang.error.invalidvalue',
  unknown: 'eewbot.scmd.lang.error.unknownlanguage',
  failed: 'eewbot.scmd.lang.error.unknown',
} as const

export type TranslationKey = keyof typeof keys

export function translate(language: string, key: TranslationKey, ...values: string[]): string {
  return formatCoreText(language, keys[key], ...values)
}
