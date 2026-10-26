// Codes/names and the three Java /lang translations come from languages.json
// and lang/<locale>/eewbot.json. This is the only supported-language definition.
export const LANGUAGES = [
  { code: 'ja_jp', name: '日本語', messages: {
    set: 'このチャンネルの言語を**%s**に設定しました。',
    applyLabel: 'このサーバーのすべてのチャンネルに適用',
    applied: 'このサーバーのすべてのチャンネルの言語を**%s**に設定しました。',
    count: '更新した配信先: %s件',
    stale: '設定が変更されたか、この操作の有効期限が切れました。再度 /lang を実行してください。',
    invalid: '言語を一覧から1つだけ選択してください。',
    unknown: '未対応の言語設定です。表示は日本語にフォールバックしています。一括適用する前に言語を選択してください。',
    failed: '言語設定に失敗しました。再度 /lang を実行して現在の設定を確認してください。',
  } },
  { code: 'en_us', name: 'English, US', messages: {
    set: 'Language has been set to **%s** for this channel.',
    applyLabel: 'Apply to all channels in this server',
    applied: 'Language has been set to **%s** for all channels in this server.',
    count: 'Updated destinations: %s',
  } },
  { code: 'zh_tw', name: '中文（台灣）', messages: {
    set: '此頻道的語言已設定為**%s**。',
    applyLabel: '一併更改此伺服器的所有頻道語言設定',
    applied: '此伺服器的所有頻道語言已設定為**%s**。',
    count: '已更新的傳送目標：%s',
  } },
  { code: 'ko_hanja', name: '한자', messages: {
    set: '이 채널의 言語를 **%s**로 設定했습니다.',
    applyLabel: '이 서버의 모든 채널에 適用',
    applied: '이 서버의 모든 채널의 言語를 **%s**로 設定했습니다.',
    count: '更新한 對象: %s',
  } },
  { code: 'ko_kp', name: '조선어', messages: {
    set: '이 통로의 언어를 **%s**로 설정하였습니다.',
    applyLabel: '이 봉사기의 모든 통로에 적용',
    applied: '이 봉사기의 모든 통로의 언어를 **%s**로 설정하였습니다.',
    count: '갱신한 통로: %s',
  } },
] as const

export type LanguageCode = typeof LANGUAGES[number]['code']
export type TranslationKey = keyof typeof LANGUAGES[0]['messages']

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGES.some((language) => language.code === value)
}

export function displayLanguage(code: string) {
  return LANGUAGES.find((language) => language.code === code) ?? LANGUAGES[0]
}

export function translate(code: string, key: TranslationKey, ...values: string[]): string {
  const messages: Partial<Record<TranslationKey, string>> = displayLanguage(code).messages
  const template = messages[key] ?? LANGUAGES[0].messages[key]
  let index = 0
  return template.replace(/%s/g, () => values[index++] ?? '')
}
