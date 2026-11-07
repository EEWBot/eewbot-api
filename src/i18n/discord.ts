import { displayLanguage, type LanguageCode } from './core'

const DISCORD_LANGUAGES: Readonly<Partial<Record<string, LanguageCode>>> = {
  ja: 'ja_jp',
  'en-US': 'en_us',
  'en-GB': 'en_us',
  'zh-TW': 'zh_tw',
}

/** Only exact Core equivalents are mapped; Korean variants remain a destination choice. */
export function discordLanguage(locale: unknown): LanguageCode | undefined {
  return typeof locale === 'string' && Object.hasOwn(DISCORD_LANGUAGES, locale) ? DISCORD_LANGUAGES[locale] : undefined
}

/** Private interaction text prefers the user's Discord locale over the saved delivery language. */
export function interactionLanguage(locale: unknown, fallback = 'ja_jp'): LanguageCode {
  return discordLanguage(locale) ?? displayLanguage(fallback).code
}
