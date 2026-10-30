import type { D1Database } from '@cloudflare/workers-types'
import { storage } from '../db/storage-error'
import { LANGUAGES, type LanguageCode } from '../i18n/languages'
import { type Embed, type QuakeReport, sha256 } from './validation'

type Row = {
  snapshot_id: string
  revision: number
  event_id: string
  report_type: string
  report_date_time: string | null
  date_time: string | null
  serial: number
  info_type: string
  info_type_priority: number
  updated_at: number
}

export type QuakeSnapshot = {
  eventId: string
  reportType: string
  reportDateTime: string | null
  dateTime: string | null
  serial: number
  infoType: string
  infoTypePriority: number
  updatedAt: number
}

export type LatestQuake = {
  revision: number
  snapshot: QuakeSnapshot | null
  lang: LanguageCode
  messages: { messageIndex: number; embeds: Embed[] }[]
}

function snapshot(row: Row): QuakeSnapshot {
  return {
    eventId: row.event_id,
    reportType: row.report_type,
    reportDateTime: row.report_date_time,
    dateTime: row.date_time,
    serial: row.serial,
    infoType: row.info_type,
    infoTypePriority: row.info_type_priority,
    updatedAt: row.updated_at,
  }
}

/** Ordering key; matches Java QuakeInfoStore.isNewer(). */
const key = (alias: string) =>
  `(coalesce(${alias}.report_date_time,''), coalesce(${alias}.date_time,''), ${alias}.serial, ${alias}.info_type_priority)`

/** The latest earthquake report published by the single Java Core instance. */
export class QuakeStore {
  constructor(private readonly db: D1Database) {}

  /**
   * Replaces the latest report unless the stored one is strictly newer. An
   * identical report (Core re-sends it periodically) is accepted without a write.
   * One D1 batch (a transaction): messages are inserted only under the new
   * snapshot ID and the replaced report's messages are deleted.
   */
  async publish(report: QuakeReport, now = Date.now()): Promise<{ accepted: boolean; revision: number }> {
    const id = crypto.randomUUID()
    const hash = await sha256(JSON.stringify(report))
    const latestId = '(SELECT snapshot_id FROM quake_latest WHERE id = 1)'
    const statements = [
      this.db
        .prepare(
          `INSERT INTO quake_latest AS o (id, snapshot_id, revision, event_id, report_type, report_date_time,
             date_time, serial, info_type, info_type_priority, content_hash, updated_at)
           VALUES (1, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET snapshot_id = excluded.snapshot_id, revision = o.revision + 1,
             event_id = excluded.event_id, report_type = excluded.report_type,
             report_date_time = excluded.report_date_time, date_time = excluded.date_time,
             serial = excluded.serial, info_type = excluded.info_type,
             info_type_priority = excluded.info_type_priority, content_hash = excluded.content_hash,
             updated_at = excluded.updated_at
           WHERE ${key('excluded')} > ${key('o')}
             OR (${key('excluded')} = ${key('o')} AND excluded.content_hash <> o.content_hash)`,
        )
        .bind(
          id,
          report.eventId,
          report.reportType,
          report.reportDateTime,
          report.dateTime,
          report.serial,
          report.infoType,
          report.infoTypePriority,
          hash,
          now,
        ),
      ...LANGUAGES.flatMap(({ code }) =>
        report.languages[code].map((embeds, index) =>
          this.db
            .prepare(
              `INSERT INTO quake_messages (snapshot_id, lang, message_index, embeds_json)
               SELECT ?, ?, ?, ? WHERE ${latestId} = ?`,
            )
            .bind(id, code, index, JSON.stringify(embeds), id),
        ),
      ),
      this.db.prepare(`DELETE FROM quake_messages WHERE snapshot_id <> ${latestId}`),
      this.db.prepare('SELECT snapshot_id, content_hash, revision FROM quake_latest WHERE id = 1'),
    ]
    const results = await storage(() => this.db.batch(statements))
    const row = results.at(-1)?.results[0] as { snapshot_id: string; content_hash: string; revision: number }
    return { accepted: row.snapshot_id === id || row.content_hash === hash, revision: row.revision }
  }

  /** One statement pins metadata and messages to the same report. */
  async latest(lang: LanguageCode): Promise<LatestQuake> {
    const { results } = await storage(() =>
      this.db
        .prepare(
          `SELECT l.*, m.message_index, m.embeds_json FROM quake_latest l
           LEFT JOIN quake_messages m ON m.snapshot_id = l.snapshot_id AND m.lang = ?
           WHERE l.id = 1 ORDER BY m.message_index`,
        )
        .bind(lang)
        .all<Row & { message_index: number | null; embeds_json: string | null }>(),
    )
    const first = results[0]
    if (!first) return { revision: 0, snapshot: null, lang, messages: [] }
    return {
      revision: first.revision,
      snapshot: snapshot(first),
      lang,
      messages: results.flatMap((row) =>
        row.embeds_json === null || row.message_index === null
          ? []
          : [{ messageIndex: row.message_index, embeds: JSON.parse(row.embeds_json) as Embed[] }],
      ),
    }
  }
}
