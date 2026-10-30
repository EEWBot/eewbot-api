// Japanese UI strings for API-only authorization, validation and Discord REST failures.

export const ja = {
  auth: {
    commandsDisabled: 'コマンドは現在無効です。',
    invalidContext: 'コマンドの実行コンテキストまたは設定が無効です。',
    manageGuildRequired: 'サーバー管理権限が必要です。',
  },
  start: {
    settings: '設定処理を開始できません。',
    testmessage: 'テスト送信を開始できません。',
    quakeinfo: '地震情報の取得を開始できません。',
  },
  unsupported: 'このコマンドまたは操作には対応していません。',
  settings: {
    invalidValue: '選択値が無効です。',
    targetMismatch: '登録済みの配信先情報が一致しません。',
    failed: '設定処理に失敗しました。再度実行して現在の設定を確認してください。',
  },
  discord: {
    rateLimited: 'Discordの利用制限中です。しばらく待って再度実行してください。',
    forbidden: 'BotのDiscord権限が不足しています。',
    notFound: 'Discordの対象が見つかりません。再度実行してください。',
    unavailable: 'Discordとの通信に失敗しました。しばらく待って再度実行してください。',
    unsupportedChannel: 'このチャンネルの種類には対応していません。',
    botPermissionsRequired: 'Botにチャンネルの閲覧・メッセージ送信権限が必要です。',
  },
  invite: (url: string) => `EEWBotの招待URL: ${url}`,
} as const
