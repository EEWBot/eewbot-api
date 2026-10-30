import { coreText } from './core'
import type { LanguageCode } from './languages'

type QuakeInfoText = {
  /** Matches Java's eewbot.scmd.quakeinfo.error. */
  error: string
  report: string
  saved: string
  old: string
  partial: string
  /** Indexed by info type priority: announcement, correction, cancellation. */
  kinds: readonly [string, string, string]
}

export const quakeInfoText: Record<LanguageCode, QuakeInfoText> = {
  ja_jp: {
    error: coreText('ja_jp', 'eewbot.scmd.quakeinfo.error'),
    report: '発表日時',
    saved: '同期日時',
    old: '⚠️ 過去に発表された情報です。現在進行中の地震を示すものではありません。',
    partial: '一部の情報を送信できませんでした。送信済みの内容は再投稿していません。',
    kinds: ['発表', '訂正', '取消'],
  },
  en_us: {
    error: coreText('en_us', 'eewbot.scmd.quakeinfo.error'),
    report: 'Issued',
    saved: 'Synced',
    old: '⚠️ This is an older report; it does not indicate an earthquake currently in progress.',
    partial: 'Some messages could not be sent. Already sent messages were not reposted.',
    kinds: ['Announcement', 'Correction', 'Cancelled'],
  },
  zh_tw: {
    error: coreText('zh_tw', 'eewbot.scmd.quakeinfo.error'),
    report: '發布時間',
    saved: '同步時間',
    old: '⚠️ 這是過去發布的資訊，不代表目前正在發生地震。',
    partial: '部分訊息無法傳送，已傳送的內容不會重新發布。',
    kinds: ['發布', '訂正', '取消'],
  },
  ko_hanja: {
    error: coreText('ko_hanja', 'eewbot.scmd.quakeinfo.error'),
    report: '發表日時',
    saved: '同期日時',
    old: '⚠️ 過去에 發表된 情報입니다. 現在 進行 中인 地震을 나타내지 않습니다.',
    partial: '一部 情報를 보내지 못했습니다. 이미 보낸 內容은 다시 보내지 않았습니다.',
    kinds: ['發表', '訂正', '取消'],
  },
  ko_kp: {
    error: coreText('ko_kp', 'eewbot.scmd.quakeinfo.error'),
    report: '발표일시',
    saved: '동기일시',
    old: '⚠️ 과거에 발표된 정보입니다. 현재 진행중인 지진을 나타내지 않습니다.',
    partial: '일부 정보를 보내지 못했습니다. 이미 보낸 내용은 다시 보내지 않았습니다.',
    kinds: ['발표', '정정', '취소'],
  },
}
