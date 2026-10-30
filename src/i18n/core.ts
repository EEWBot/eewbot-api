import { CORE_LANGUAGES, CORE_MESSAGES } from './core-messages'

export const LANGUAGES = CORE_LANGUAGES
export type LanguageCode = (typeof LANGUAGES)[number]['code']

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGES.some((language) => language.code === value)
}

export function displayLanguage(code: string) {
  return LANGUAGES.find((language) => language.code === code) ?? LANGUAGES[0]
}

// Java I18n.get resolves missing keys through ja_jp, then returns the key itself.
export function coreText(language: string, key: string): string {
  const messages: Readonly<Record<string, string>> = CORE_MESSAGES[displayLanguage(language).code]
  const fallback: Readonly<Record<string, string>> = CORE_MESSAGES.ja_jp
  return (
    (Object.hasOwn(messages, key) ? messages[key] : undefined) ??
    (Object.hasOwn(fallback, key) ? fallback[key] : undefined) ??
    key
  )
}

export function formatCoreText(language: string, key: string, ...values: string[]): string {
  let index = 0
  // The shared slash-command resources use Java's %s placeholders.
  return coreText(language, key).replace(/%s/g, () => values[index++] ?? '')
}
