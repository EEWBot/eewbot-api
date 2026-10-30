// The migration and registrar share the exact owned names and command types.
export const globalCommands = [
  { name: 'ping', description: 'Test the EEWBot HTTP Interactions endpoint' },
  { name: 'setup', description: '現在のチャンネルにBotが通知する情報を設定します。', default_member_permissions: '32' },
  { name: 'unregister', description: 'このチャンネルの登録を解除します。', default_member_permissions: '32' },
  { name: 'lang', description: 'チャンネルに言語を設定します。', default_member_permissions: '32' },
  { name: 'help', description: 'Helpを表示します。' },
  { name: 'invite', description: '招待URLを取得します。' },
  { name: 'testmessage', description: 'Botからテストメッセージを送信し、現在のチャンネルで正常に動作するか確認します。' },
  { name: 'quakeinfo', description: '最新の地震情報を取得します。' },
].map(command => ({ type: 1, integration_types: [0], contexts: [0],
  // Explicit null clears a stale permission restriction during an upsert.
  default_member_permissions: null, ...command }))
