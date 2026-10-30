import { displayLanguage, type LanguageCode } from './languages'

// Java eewbot.scmd.testmessage.* translations; unknown locales fall back to Japanese.
const translations = {
  ja_jp: {
    title: 'テストメッセージ',
    webhook: 'Webhookによる配信が有効です。',
    nowebhook:
      ':warning:Webhookによる低遅延配信が無効です。\n有効化には、Botにウェブフックの管理権限があるかご確認の上、再度/setupを実行してください。',
    webhooksender: 'Webhookによる低遅延配信が有効です。',
    'success.webhook': 'Botからメッセージを送信するテストに成功しました！',
    'success.nowebhook': 'Botからメッセージを送信するテストに成功しました！',
    'success.webhooksender':
      'テストメッセージの配信を予約しました。通常、数秒以内に配信されます。\nテストメッセージが配信されない場合、[サポート](https://support.eewbot.net/)にお問い合わせください。',
    'error.title': ':warning: テストに失敗しました！',
    'error.missingperms':
      'メッセージを送信できませんでした。\nBotがこのチャンネルを閲覧する権限と、メッセージを送信する権限があるかご確認ください。\nこのチャンネルをBotに登録していた場合は、権限の修正後に再度/setupを実行する必要があります。',
    'error.ratelimit': 'メッセージを送信できませんでした。\nしばらく経ってから再度お試しください。',
    'error.unknownwebhook':
      'メッセージを送信できませんでした。\nWebhookが削除されています！\n/setup コマンドを再度実行してください。',
    'error.unknown': 'メッセージを送信できませんでした。\n不明なエラーが発生しました。',
    'error.configuration':
      '送信設定を確認できません。管理者にWebhook SenderまたはWebhookの設定確認を依頼してください。',
    'error.unavailable': '送信先サービスを利用できません。しばらく待ってから再度お試しください。',
    'error.uncertain':
      '送信結果を確認できませんでした。二重投稿を避けるため自動再送していません。チャンネルを確認してから、しばらく待って再度お試しください。',
  },
  en_us: {
    title: 'Test Message',
    webhook: 'Using Webhook.',
    nowebhook:
      ':warning: Low latency delivery via webhook is disabled.\nTo enable it, ensure the bot has permission to manage webhooks and run /setup again.',
    webhooksender: 'Low latency delivery via webhook is enabled.',
    'success.webhook': 'Successfully sent a test message from the bot!',
    'success.nowebhook': 'Successfully sent a test message from the bot!',
    'success.webhooksender':
      'The test message has been queued for delivery and should arrive within a few seconds.\nIf you do not receive the test message, please contact [Support](https://support.eewbot.net/).',
    'error.title': ':warning: Test Failed!',
    'error.missingperms':
      'Unable to send message.\nPlease check if the bot has permission to view and send messages in this channel.\nIf this channel was already registered with the bot, you will need to run /setup again after modifying the permissions.',
    'error.ratelimit': 'Unable to send message.\nPlease try again later.',
    'error.unknownwebhook': 'Unable to send message.\nWebhook has been deleted!\nPlease run again the /setup command.',
    'error.unknown': 'Unable to send message.\nAn unknown error has occurred.',
    'error.configuration':
      'Delivery configuration is invalid. Ask an administrator to check the Sender or webhook settings.',
    'error.unavailable': 'The delivery service is unavailable. Please try again later.',
    'error.uncertain':
      'The delivery result is unknown. No automatic retry was made. Check the channel before trying again later.',
  },
  zh_tw: {
    title: '測試訊息',
    webhook: '已啟用透過 Webhook 發送。',
    nowebhook:
      ':warning:透過 Webhook 進行的低延遲串流已停用。\n若要啟用，請確認機器人是否擁有管理 Webhook 的權限，並重新執行 /setup。',
    webhooksender: '透過 Webhook 的低延遲傳輸功能已啟用。',
    'success.webhook': '已成功完成從 Bot 發送訊息的測試！',
    'success.nowebhook': '已成功完成從 Bot 發送訊息的測試！',
    'success.webhooksender':
      '已預約發送測試訊息。通常會在幾秒鐘內送達。\n如果未收到測試訊息，請聯繫[支援中心](https://support.eewbot.net/)。',
    'error.title': ':warning: 測試失敗！',
    'error.missingperms':
      '訊息未傳送。\n請確認Bot是否已開啟檢視、傳送訊息的權限。\n如果此頻道先前已完成Bot的操作，請修正權限後再次/setup。',
    'error.ratelimit': '無法傳送訊息。\n請稍等再試。',
    'error.unknownwebhook': '無法傳送訊息。\nWebhook已被刪除！\n請再次執行/setup 指令。',
    'error.unknown': '無法傳送訊息。\n發生不明錯誤。',
    'error.configuration': '傳送設定無效。請管理員檢查 Sender 或 Webhook 設定。',
    'error.unavailable': '傳送服務暫時無法使用，請稍後再試。',
    'error.uncertain': '無法確認傳送結果。為避免重複訊息，未自動重試。請先確認頻道並稍後再試。',
  },
  ko_hanja: {
    title: '테스트 메시지',
    webhook: '웹훅을 通한 傳送이 活性化되어 있습니다.',
    nowebhook:
      ':warning: 웹훅을 通한 低遲延 傳送이 非活性化되어 있습니다.\n活性化하려면 봇에게 웹훅 管理 權限이 있는지 確認한 後 /setup을 다시 實行해 주세요.',
    webhooksender: '웹훅을 通한 低遲延 傳送이 活性化되어 있습니다.',
    'success.webhook': '봇에서 테스트 메시지를 成功的으로 傳送했습니다!',
    'success.nowebhook': '봇에서 테스트 메시지를 成功的으로 傳送했습니다!',
    'success.webhooksender':
      '테스트 메시지 傳送이 豫約되었습니다. 普通 數 秒 內에 傳送됩니다.\n테스트 메시지가 傳送되지 않으면 [支援 서버](https://support.eewbot.net/)로 問議해 주세요.',
    'error.title': ':warning: 테스트에 失敗했습니다!',
    'error.missingperms':
      '메시지를 傳送할 수 없었습니다.\n봇에게 이 채널의 보기 權限과 메시지 傳送 權限이 있는지 確認해 주세요.\n이 채널이 이미 봇에 登錄되어 있는 境遇, 權限 修正 後 /setup을 다시 實行해야 합니다.',
    'error.ratelimit': '메시지를 傳送할 수 없었습니다.\n暫時 後 다시 試圖해 주세요.',
    'error.unknownwebhook':
      '메시지를 傳送할 수 없었습니다.\n웹훅이 削除되었습니다!\n/setup 命令語를 다시 實行해 주세요.',
    'error.unknown': '메시지를 傳送할 수 없었습니다.\n알 수 없는 誤謬가 發生했습니다.',
    'error.configuration': '傳送 設定이 有效하지 않습니다. 管理者에게 Sender 또는 Webhook 設定 確認을 要請하세요.',
    'error.unavailable': '傳送 서비스를 使用할 수 없습니다. 잠시 後 다시 試圖하세요.',
    'error.uncertain':
      '傳送 結果를 確認할 수 없습니다. 重複을 防止하기 위해 自動 再試圖하지 않았습니다. 채널을 確認한 後 잠시 기다려 주세요.',
  },
  ko_kp: {
    title: '시험통보문',
    webhook: 'Webhook를 리용한 배포가 유효합니다.',
    nowebhook:
      ':warning: Webhook를 리용한 지연이 낮은 배포가 유효합니다.\n활성화하려면 Bot에 Webhook관리권한이 있는지 확인한 다음 다시 /setup지령을 실행하여주십시오.',
    webhooksender: 'Webhook를 리용한 지연이 낮은 배포가 유효합니다.',
    'success.webhook': 'Bot에서의 통보문배포시험이 성공하였습니다!',
    'success.nowebhook': 'Bot에서의 통보문배포시험이 성공하였습니다!',
    'success.webhooksender':
      '시험통보문배포를 예약하였습니다. 보통 수초내에 배포됩니다.\n시험통보문이 배포되지 않는 경우에는 [지원](https://support.eewbot.net/)에 문의하여주십시오.',
    'error.title': ':warning: 시험에 실패하였습니다!',
    'error.missingperms':
      '통보문을 보낼수 없습니다.\nBot에게 이 통로의 열람권한과 통보문을 보낼 권한이 있는지 확인하여주십니오.\n이 통로를 Bot에 등록한 경우에는, 권한을 수정한 다음 다시 /setup 지령을 실행하여야 합니다.',
    'error.ratelimit': '통보문을 보낼수 없습니다.\n얼마간 지난 다음 다시 시도하여주십시오.',
    'error.unknownwebhook':
      '통보문을 보낼수 없습니다.\nWebhook가 삭제되였습니다.\n/setup 지령을 다시 실행하여주십시오.',
    'error.unknown': '통보문을 보낼수 없습니다.\n알수 없는 오유가 발생하였습니다.',
    'error.configuration': '배포설정이 올바르지 않습니다. 관리자에게 Sender 또는 Webhook 설정확인을 요청하여주십시오.',
    'error.unavailable': '배포봉사를 리용할수 없습니다. 잠시후 다시 시도하여주십시오.',
    'error.uncertain':
      '배포결과를 확인할수 없습니다. 중복배포를 피하기 위하여 자동으로 다시 보내지 않았습니다. 통로를 확인한 다음 잠시 기다려주십시오.',
  },
} satisfies Record<LanguageCode, Record<string, string>>

export type TestMessageKey = keyof typeof translations.ja_jp
export function testMessageText(language: string, key: TestMessageKey): string {
  return translations[displayLanguage(language).code][key]
}
