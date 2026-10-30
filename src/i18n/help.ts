import { displayLanguage, type LanguageCode } from './languages'

// Java Help translations; missing keys use Japanese. URLs are fixed source literals.
// Japanese is complete and is the fallback for every other language.
const translations: { ja_jp: Record<HelpKey, string> } & Record<LanguageCode, Partial<Record<HelpKey, string>>> = {
  ja_jp: {
    title: 'Help',
    desc: 'スラッシュコマンドを使用します。\n`/`を入力してBotのアイコンを選択すると、利用可能なコマンドが一覧表示されます。',
    setup:
      'コマンドを実行しているチャンネルに、Botが通知する情報の種類・最小震度を設定します。デフォルトでは、サーバー管理権限が必要です。',
    quakeinfo: '最新の地震情報を取得します。',
    invite: 'Botの招待URLを取得します。',
    testmessage: 'Botからテストメッセージを送信し、現在のチャンネルで正常に動作するか確認します。',
    lang: 'Botの言語を設定します。デフォルトでは、サーバー管理権限が必要です。',
    unregister: 'このチャンネル(またはDM)の通知登録を削除します。デフォルトでは、サーバー管理権限が必要です。',
    help: 'Helpを表示します。',
    linksName: 'リンク',
    links:
      '[コマンドリファレンス](https://github.com/EEWBot/EEWBot/wiki/%E3%82%B3%E3%83%9E%E3%83%B3%E3%83%89%E3%83%AA%E3%83%95%E3%82%A1%E3%83%AC%E3%83%B3%E3%82%B9) [GitHub](https://github.com/EEWBot/EEWBot) [サポートサーバー](https://discord.gg/upt9n86ctG)',
    legalName: '法的情報',
    legal: '[プライバシーポリシー](https://eewbot.net/privacy) [利用規約](https://eewbot.net/terms)',
  },
  en_us: {
    title: 'Help',
    desc: "Use slash commands.\nType `/` and select the bot's avatar to display a list of available commands.",
    setup:
      'Sets the type of information and minimum seismic intensity that the bot will notify in the current channel. By default, Manage Server permission is required.',
    quakeinfo: 'Retrieves the latest earthquake information.',
    invite: 'Get the bot’s invite URL.',
    testmessage: 'Send a test message from the bot to verify if it works correctly in the current channel.',
    lang: 'Set the bot’s language. Requires manage server permission by default.',
    unregister:
      'Deletes the notification registration for this channel (or DM). Requires manage server permission by default.',
    help: 'Display help.',
    linksName: 'Links',
    links:
      '[Command reference](https://github.com/EEWBot/EEWBot/wiki/%E3%82%B3%E3%83%9E%E3%83%B3%E3%83%89%E3%83%AA%E3%83%95%E3%82%A1%E3%83%AC%E3%83%B3%E3%82%B9)\n[GitHub](https://github.com/EEWBot/EEWBot)\n[Support Server](https://discord.gg/upt9n86ctG)',
    legalName: 'Legal',
    legal: '[Privacy Policy](https://eewbot.net/privacy)\n[Terms of Service](https://eewbot.net/terms)',
  },
  zh_tw: {
    title: 'Help',
    desc: '正在使用斜槓指令。\n輸入`/`並選擇Bot的圖像可以顯示指令列表。',
    setup: '請在要設定的頻道中使用此指令。設定Bot要推送的資訊種類、最小震度。需要伺服器的管理員權限才能使用。',
    quakeinfo: '取得最新的地震資訊。',
    invite: '顯示Bot的邀請網址。',
    testmessage: '從Bot發送測試訊息，確認現在的頻道是否正常運作。',
    lang: '設定Bot的語言。需要伺服器的管理員權限才能使用。',
    help: '顯示幫助。',
    linksName: '網址',
    links:
      '[指令參考](https://github.com/EEWBot/EEWBot/wiki/%E3%82%B3%E3%83%9E%E3%83%B3%E3%83%89%E3%83%AA%E3%83%95%E3%82%A1%E3%83%AC%E3%83%B3%E3%82%B9)\n[GitHub](https://github.com/EEWBot/EEWBot)\n[聯絡我們](https://discord.gg/upt9n86ctG)',
  },
  ko_hanja: {
    title: '도움말',
    desc: '슬래시 命令語를 使用합니다.\n`/`를 入力한 後 봇 아이콘을 選擇하면 使用 可能한 命令語 目錄이 表示됩니다.',
    setup: '現在 채널에 봇이 傳送할 情報의 種類와 最小 震度를 設定합니다. 基本的으로 서버 管理 權限이 必要합니다.',
    quakeinfo: '最新 地震 情報를 가져옵니다.',
    invite: '봇 招待 URL을 가져옵니다.',
    testmessage: '봇에서 테스트 메시지를 傳送하여 現在 채널에서 正常的으로 動作하는지 確認합니다.',
    lang: '봇의 言語를 設定합니다. 基本的으로 서버 管理 權限이 必要합니다.',
    help: '도움말을 表示합니다.',
    linksName: '링크',
    links:
      '[命令語 레퍼런스](https://github.com/EEWBot/EEWBot/wiki/%E3%82%B3%E3%83%9E%E3%83%B3%E3%83%89%E3%83%AA%E3%83%95%E3%82%A1%E3%83%AC%E3%83%B3%E3%82%B9) [GitHub](https://github.com/EEWBot/EEWBot) [支援 서버](https://discord.gg/upt9n86ctG)',
  },
  ko_kp: {
    title: '도움말',
    desc: '사선지령을 사용합니다.\n`/`를 입력하고 Bot그림기호를 선택하면 리용할수 있는 지령들이 현시됩니다.',
    setup:
      '지령을 실행할 통로에 Bot가 알릴 정보의 종류 및 최소지진세기를 설정합니다. 기정으로 봉사기관리권한이 필요합니다.',
    quakeinfo: '최신지진정보를 취득합니다.',
    invite: 'Bot초대련결을 취득합니다.',
    testmessage: 'Bot에서 시험통보문을 보내서 현재 통로에서 정상적으로 동작하는지 확인합니다.',
    lang: 'Bot의 언어를 설정합니다. 기본값으로는 봉사기관리권한이 필요합니다.',
    help: '도움말을 현시합니다.',
    linksName: '련결',
    links:
      '[지령참고](https://github.com/EEWBot/EEWBot/wiki/%E3%82%B3%E3%83%9E%E3%83%B3%E3%83%89%E3%83%AA%E3%83%95%E3%82%A1%E3%83%AC%E3%83%B3%E3%82%B9) [GitHub](https://github.com/EEWBot/EEWBot) [지원봉사기](https://discord.gg/upt9n86ctG)',
  },
}

type HelpKey =
  | 'title'
  | 'desc'
  | 'setup'
  | 'quakeinfo'
  | 'invite'
  | 'testmessage'
  | 'lang'
  | 'unregister'
  | 'help'
  | 'linksName'
  | 'links'
  | 'legalName'
  | 'legal'

export function helpText(code: string, key: HelpKey): string {
  return translations[displayLanguage(code).code][key] ?? translations.ja_jp[key]
}
