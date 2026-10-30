import { displayLanguage, formatCoreText, type LanguageCode } from './core'

export { displayLanguage, isLanguageCode, LANGUAGES, type LanguageCode } from './core'

const keys = {
  set: 'eewbot.scmd.lang.set.followup',
  applyLabel: 'eewbot.scmd.lang.applyall.label',
  applied: 'eewbot.scmd.lang.applyall.followup',
} as const

// API validation guidance and update counts have no Java Core equivalent.
const messages = {
  ja_jp: {
    count: '更新した配信先: %s件',
    stale: '設定が変更されたか、この操作の有効期限が切れました。再度 /lang を実行してください。',
    invalid: '言語を一覧から1つだけ選択してください。',
    unknown: '未対応の言語設定です。表示は日本語にフォールバックしています。一括適用する前に言語を選択してください。',
    failed: '言語設定に失敗しました。再度 /lang を実行して現在の設定を確認してください。',
  },
  en_us: { count: 'Updated destinations: %s' },
  zh_tw: { count: '已更新的傳送目標：%s' },
  ko_hanja: { count: '更新한 對象: %s' },
  ko_kp: { count: '갱신한 통로: %s' },
} satisfies Record<LanguageCode, Partial<Record<string, string>>>

export type TranslationKey = keyof typeof keys | keyof typeof messages.ja_jp

export function translate(language: string, key: TranslationKey, ...values: string[]): string {
  if (key === 'set' || key === 'applyLabel' || key === 'applied') return formatCoreText(language, keys[key], ...values)
  const localized: Partial<Record<keyof typeof messages.ja_jp, string>> = messages[displayLanguage(language).code]
  let index = 0
  return (localized[key] ?? messages.ja_jp[key]).replace(/%s/g, () => values[index++] ?? '')
}
