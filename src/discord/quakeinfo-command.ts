import { D1DestinationStore } from '../db/d1-destination-store'
import type { Bindings } from '../env'
import { displayLanguage, type LanguageCode } from '../i18n/languages'
import { QuakeStore } from '../quakeinfo/store'
import { DiscordRest } from './rest'
import type { Interaction, InteractionMessage } from './types'

// Error strings match Java's eewbot.scmd.quakeinfo.error.
const text: Record<LanguageCode, { error: string; report: string; saved: string; old: string; partial: string; kinds: string[] }> = {
  ja_jp: { error: '地震情報を取得できませんでした。時間をあけて再度お試しください。', report: '発表日時', saved: '同期日時',
    old: '⚠️ 過去に発表された情報です。現在進行中の地震を示すものではありません。',
    partial: '一部の情報を送信できませんでした。送信済みの内容は再投稿していません。', kinds: ['発表','訂正','取消'] },
  en_us: { error: 'Failed to retrieve earthquake information. Please try again later.', report: 'Issued', saved: 'Synced',
    old: '⚠️ This is an older report; it does not indicate an earthquake currently in progress.',
    partial: 'Some messages could not be sent. Already sent messages were not reposted.', kinds: ['Announcement','Correction','Cancelled'] },
  zh_tw: { error: '無法取得地震資訊。請稍候再試。', report: '發布時間', saved: '同步時間',
    old: '⚠️ 這是過去發布的資訊，不代表目前正在發生地震。',
    partial: '部分訊息無法傳送，已傳送的內容不會重新發布。', kinds: ['發布','訂正','取消'] },
  ko_hanja: { error: '地震 情報를 가져올 수 없었습니다. 暫時 後 다시 試圖해 주세요.', report: '發表日時', saved: '同期日時',
    old: '⚠️ 過去에 發表된 情報입니다. 現在 進行 中인 地震을 나타내지 않습니다.',
    partial: '一部 情報를 보내지 못했습니다. 이미 보낸 內容은 다시 보내지 않았습니다.', kinds: ['發表','訂正','取消'] },
  ko_kp: { error: '지진정보를 얻을수 없었습니다. 얼마간 지난 다음 다시 시도하여주십시오.', report: '발표일시', saved: '동기일시',
    old: '⚠️ 과거에 발표된 정보입니다. 현재 진행중인 지진을 나타내지 않습니다.',
    partial: '일부 정보를 보내지 못했습니다. 이미 보낸 내용은 다시 보내지 않았습니다.', kinds: ['발표','정정','취소'] },
}
export function isQuakeInfoInteraction(i: Interaction): boolean { return i.type === 2 && i.data?.name === 'quakeinfo' }

export async function processQuakeInfo(i: Interaction, env: Bindings): Promise<void> {
  const rest = new DiscordRest('', Date.now() + 25_000)
  let language: LanguageCode = 'ja_jp'
  let original: InteractionMessage | undefined
  try {
    if (!env.DB) throw new Error('storage_unavailable')
    const sql = env.DB.withSession('first-primary')
    // A signed interaction receipt prevents a redelivery from restarting followup POSTs.
    const [, claim] = await sql.batch([
      sql.prepare('DELETE FROM quake_interactions WHERE expires_at < ?').bind(Date.now()),
      sql.prepare(`INSERT INTO quake_interactions (interaction_id,expires_at) SELECT ?,?
        WHERE (SELECT count(*) FROM quake_interactions) < 100000 ON CONFLICT DO NOTHING`).bind(i.id!,Date.now() + 20 * 60_000),
    ])
    if (claim.meta.changes !== 1) {
      if (await sql.prepare('SELECT 1 FROM quake_interactions WHERE interaction_id = ?').bind(i.id!).first()) return
      throw new Error('interaction_capacity')
    }
    const destination = await new D1DestinationStore(env.DB).getDestination(i.channel_id!)
    if (destination && destination.guildId === i.guild_id) language = displayLanguage(destination.lang).code
    const latest = await new QuakeStore(env.DB).latest(language)
    const t = text[language]
    if (!latest.snapshot) {
      await rest.edit(i, { content: t.error, allowed_mentions: { parse: [] } })
      return
    }
    const issued = latest.snapshot.reportDateTime ?? latest.snapshot.dateTime
    const seconds = issued === null ? null : Math.floor(Date.parse(issued) / 1000)
    // Explicit report time survives indefinitely, even when the Java publisher is stopped.
    const heading = `${t.report}: ${seconds === null ? '—' : `<t:${seconds}:F>`} · ${t.kinds[latest.snapshot.infoTypePriority]}`
      + `\n${t.saved}: <t:${Math.floor(latest.snapshot.committedAt! / 1000)}:F>`
      + (seconds === null || Date.now() - seconds * 1000 > 24 * 60 * 60_000 ? `\n${t.old}` : '')
    const first = latest.messages[0]
    original = { content: heading, embeds: first.embeds, allowed_mentions: { parse: [] } }
    await rest.edit(i, original)
    for (const message of latest.messages.slice(1)) {
      await rest.followup(i, { embeds: message.embeds, allowed_mentions: { parse: [] } })
    }
  } catch {
    // Preserve the first page when a later POST fails; never restart the send loop.
    const content = original ? original.content + '\n' + text[language].partial : text[language].error
    try { await rest.edit(i, { ...original, content, allowed_mentions: { parse: [] } }) }
    catch { console.warn({ event: 'quakeinfo_response_failed', interactionId: i.id }) }
  }
}
