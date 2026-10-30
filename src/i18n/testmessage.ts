import { coreText, displayLanguage, formatCoreText, type LanguageCode } from './core'

// API transport outcomes have no Java Core equivalent.
const messages = {
  ja_jp: {
    'error.configuration':
      '送信設定を確認できません。管理者にWebhook SenderまたはWebhookの設定確認を依頼してください。',
    'error.unavailable': '送信先サービスを利用できません。しばらく待ってから再度お試しください。',
    'error.uncertain':
      '送信結果を確認できませんでした。二重投稿を避けるため自動再送していません。チャンネルを確認してから、しばらく待って再度お試しください。',
  },
  en_us: {
    'error.configuration':
      'Delivery configuration is invalid. Ask an administrator to check the Sender or webhook settings.',
    'error.unavailable': 'The delivery service is unavailable. Please try again later.',
    'error.uncertain':
      'The delivery result is unknown. No automatic retry was made. Check the channel before trying again later.',
  },
  zh_tw: {
    'error.configuration': '傳送設定無效。請管理員檢查 Sender 或 Webhook 設定。',
    'error.unavailable': '傳送服務暫時無法使用，請稍後再試。',
    'error.uncertain': '無法確認傳送結果。為避免重複訊息，未自動重試。請先確認頻道並稍後再試。',
  },
  ko_hanja: {
    'error.configuration': '傳送 設定이 有效하지 않습니다. 管理者에게 Sender 또는 Webhook 設定 確認을 要請하세요.',
    'error.unavailable': '傳送 서비스를 使用할 수 없습니다. 잠시 後 다시 試圖하세요.',
    'error.uncertain':
      '傳送 結果를 確認할 수 없습니다. 重複을 防止하기 위해 自動 再試圖하지 않았습니다. 채널을 確認한 後 잠시 기다려 주세요.',
  },
  ko_kp: {
    'error.configuration': '배포설정이 올바르지 않습니다. 관리자에게 Sender 또는 Webhook 설정확인을 요청하여주십시오.',
    'error.unavailable': '배포봉사를 리용할수 없습니다. 잠시후 다시 시도하여주십시오.',
    'error.uncertain':
      '배포결과를 확인할수 없습니다. 중복배포를 피하기 위하여 자동으로 다시 보내지 않았습니다. 통로를 확인한 다음 잠시 기다려주십시오.',
  },
} satisfies Record<LanguageCode, Record<string, string>>

export type TestMessageKey =
  | 'title'
  | 'webhook'
  | 'nowebhook'
  | 'webhooksender'
  | 'success.webhook'
  | 'success.nowebhook'
  | 'success.webhooksender'
  | 'error.title'
  | 'error.missingperms'
  | 'error.ratelimit'
  | 'error.unknownwebhook'
  | 'error.unknown'
  | keyof typeof messages.ja_jp

export function testMessageText(language: string, key: TestMessageKey): string {
  if (key === 'error.configuration' || key === 'error.unavailable' || key === 'error.uncertain') {
    return messages[displayLanguage(language).code][key]
  }
  // Never put exception details or token-bearing URLs into Java's error argument.
  if (key === 'error.unknown') return formatCoreText(language, `eewbot.scmd.testmessage.${key}`, '')
  return coreText(language, `eewbot.scmd.testmessage.${key}`)
}
