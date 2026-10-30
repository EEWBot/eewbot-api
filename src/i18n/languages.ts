import { formatCoreText } from './core'

export { displayLanguage, isLanguageCode, LANGUAGES, type LanguageCode } from './core'

const keys = {
  set: 'eewbot.scmd.lang.set.followup',
  applyLabel: 'eewbot.scmd.lang.applyall.label',
  applied: 'eewbot.scmd.lang.applyall.followup',
  count: 'eewbot.scmd.api.lang.count',
  stale: 'eewbot.scmd.api.lang.stale',
  invalid: 'eewbot.scmd.api.lang.invalid',
  unknown: 'eewbot.scmd.api.lang.unknown',
  failed: 'eewbot.scmd.api.lang.failed',
} as const

export type TranslationKey = keyof typeof keys

export function translate(language: string, key: TranslationKey, ...values: string[]): string {
  return formatCoreText(language, keys[key], ...values)
}
