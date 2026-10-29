import type { D1Database } from '@cloudflare/workers-types'
import { LANGUAGES, type LanguageCode } from '../i18n/languages'
import { canonical, encoder, MAX_RESPONSE_BYTES, QuakeError, sha256, type Embed, type SnapshotInput } from './validation'

export const STAGING_RETENTION_MS = 60 * 60 * 1000
export const RETIRED_RETENTION_MS = 24 * 60 * 60 * 1000
export const MAX_SNAPSHOTS = 4096
export const MAX_STORED_BYTES = 256 * 1024 * 1024
type Row = {
  snapshot_id: string; schema_version: number; event_id: string; report_type: string
  report_date_time: string | null; date_time: string | null; serial: number; info_type: string
  info_type_priority: number; is_cancel: number; rendered_at: string; content_hash: string
  publisher_epoch: number; publisher_sequence: number; status: string; created_at: number
  committed_at: number | null; quake_revision: number; request_hash: string
}
export function metadata(row: Row) {
  return { snapshotId: row.snapshot_id, schemaVersion: row.schema_version, eventId: row.event_id,
    reportType: row.report_type, reportDateTime: row.report_date_time, dateTime: row.date_time,
    serial: row.serial, infoType: row.info_type, infoTypePriority: row.info_type_priority,
    isCancel: row.is_cancel === 1, renderedAt: row.rendered_at, contentHash: row.content_hash,
    publisherEpoch: row.publisher_epoch, publisherSequence: row.publisher_sequence,
    createdAt: row.created_at, committedAt: row.committed_at }
}
// The first four columns exactly match QuakeInfoStore.isNewer(), including nulls and int serials.
const key = (alias: string) => `(coalesce(${alias}.report_date_time,''), coalesce(${alias}.date_time,''), ${alias}.serial, ${alias}.info_type_priority)`
const sameSource = `n.event_id = o.event_id AND n.report_type = o.report_type
  AND n.info_type = o.info_type AND n.is_cancel = o.is_cancel`
const complete = `(SELECT count(*) FROM quake_snapshot_manifest e JOIN quake_snapshot_messages m
  ON m.snapshot_id = e.snapshot_id AND m.lang = e.lang AND m.message_index = e.message_index
  AND m.content_hash = e.content_hash AND length(CAST(m.embeds_json AS BLOB)) = e.byte_length
  WHERE e.snapshot_id = n.snapshot_id) = n.expected_messages`

export class QuakeStore {
  private readonly sql: ReturnType<D1Database['withSession']>
  constructor(db: D1Database) { this.sql = db.withSession('first-primary') }

  async lease(publisherId: string, now = Date.now()): Promise<number> {
    await this.cleanup(now)
    // Idempotent boot UUID; the counter never decreases, even after lease cleanup.
    const result = await this.sql.batch([
      this.sql.prepare(`INSERT INTO quake_publisher_leases (publisher_id,publisher_epoch,created_at)
        SELECT ?, publisher_epoch + 1, ? FROM quake_publisher_state WHERE id = 1
        AND publisher_epoch < 9007199254740991
        AND (SELECT count(*) FROM quake_publisher_leases) < 4096
        AND NOT EXISTS (SELECT 1 FROM quake_publisher_leases WHERE publisher_id = ?)`)
        .bind(publisherId, now, publisherId),
      this.sql.prepare(`UPDATE quake_publisher_state SET publisher_epoch = max(publisher_epoch,
        coalesce((SELECT publisher_epoch FROM quake_publisher_leases WHERE publisher_id = ?),0)) WHERE id = 1`).bind(publisherId),
      this.sql.prepare('SELECT publisher_epoch FROM quake_publisher_leases WHERE publisher_id = ?').bind(publisherId),
    ])
    const row = result[2].results[0] as { publisher_epoch: number } | undefined
    if (!row) throw new QuakeError('capacity_exceeded', 503)
    return row.publisher_epoch
  }

  async create(input: SnapshotInput, now = Date.now()): Promise<void> {
    await this.cleanup(now)
    const requestHash = await sha256(canonical(input))
    const entries = LANGUAGES.flatMap(({ code }) => input.languages[code].map((e, index) => ({ ...e, code, index })))
    const total = entries.reduce((n, e) => n + e.byteLength, 0)
    const statements = [this.sql.prepare(`INSERT INTO quake_snapshots
      (snapshot_id,schema_version,event_id,report_type,report_date_time,date_time,serial,info_type,
       info_type_priority,is_cancel,rendered_at,content_hash,request_hash,publisher_epoch,publisher_sequence,
       expected_messages,expected_bytes,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE
      (SELECT publisher_epoch FROM quake_publisher_state WHERE id = 1) = ?
      AND (SELECT count(*) FROM quake_snapshots) < ?
      AND (SELECT coalesce(sum(expected_bytes),0) FROM quake_snapshots) + ? <= ?
      AND NOT EXISTS (SELECT 1 FROM quake_snapshots WHERE snapshot_id = ?
        OR (publisher_epoch = ? AND publisher_sequence = ?))`)
      .bind(input.snapshotId,1,input.eventId,input.reportType,input.reportDateTime,input.dateTime,input.serial,
        input.infoType,input.infoTypePriority,Number(input.isCancel),input.renderedAt,input.contentHash,requestHash,
        input.publisherEpoch,input.publisherSequence,entries.length,total,now,input.publisherEpoch,
        MAX_SNAPSHOTS,total,MAX_STORED_BYTES,input.snapshotId,input.publisherEpoch,input.publisherSequence)]
    for (const e of entries) statements.push(this.sql.prepare(`INSERT INTO quake_snapshot_manifest
      (snapshot_id,lang,message_index,content_hash,byte_length) SELECT ?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM quake_snapshots WHERE snapshot_id = ? AND request_hash = ?)
      ON CONFLICT DO NOTHING`).bind(input.snapshotId,e.code,e.index,e.contentHash,e.byteLength,input.snapshotId,requestHash))
    statements.push(this.sql.prepare('SELECT request_hash FROM quake_snapshots WHERE snapshot_id = ?').bind(input.snapshotId))
    const results = await this.sql.batch(statements)
    const row = results.at(-1)!.results[0] as { request_hash: string } | undefined
    if (row?.request_hash === requestHash) return
    if (row) throw new QuakeError('snapshot_conflict', 409)
    const epoch = await this.sql.prepare('SELECT publisher_epoch FROM quake_publisher_state WHERE id = 1').first<number>('publisher_epoch')
    if (epoch !== input.publisherEpoch) throw new QuakeError('publisher_fenced', 409)
    const used = await this.sql.prepare('SELECT 1 FROM quake_snapshots WHERE publisher_epoch = ? AND publisher_sequence = ?')
      .bind(input.publisherEpoch,input.publisherSequence).first()
    throw new QuakeError(used ? 'sequence_conflict' : 'capacity_exceeded', used ? 409 : 503)
  }

  async put(id: string, lang: LanguageCode, index: number, body: string): Promise<void> {
    const hash = await sha256(body)
    const result = await this.sql.batch([
      this.sql.prepare(`INSERT INTO quake_snapshot_messages (snapshot_id,lang,message_index,embeds_json,content_hash)
        SELECT e.snapshot_id,e.lang,e.message_index,?,? FROM quake_snapshot_manifest e
        JOIN quake_snapshots n ON n.snapshot_id = e.snapshot_id
        WHERE e.snapshot_id = ? AND e.lang = ? AND e.message_index = ?
        AND e.content_hash = ? AND e.byte_length = ? AND n.status = 'staging'
        AND n.publisher_epoch = (SELECT publisher_epoch FROM quake_publisher_state WHERE id = 1)
        ON CONFLICT DO NOTHING`).bind(body,hash,id,lang,index,hash,encoder.encode(body).byteLength),
      this.sql.prepare('SELECT content_hash,embeds_json FROM quake_snapshot_messages WHERE snapshot_id = ? AND lang = ? AND message_index = ?')
        .bind(id,lang,index),
    ])
    const stored = result[1].results[0] as { content_hash: string; embeds_json: string } | undefined
    if (stored?.content_hash === hash && stored.embeds_json === body) return
    const row = await this.sql.prepare(`SELECT n.publisher_epoch AS epoch, p.publisher_epoch AS current_epoch
      FROM quake_snapshots n CROSS JOIN quake_publisher_state p WHERE n.snapshot_id = ? AND p.id = 1`).bind(id)
      .first<{ epoch: number; current_epoch: number }>()
    if (row && row.epoch !== row.current_epoch) throw new QuakeError('publisher_fenced', 409)
    throw new QuakeError('message_conflict', 409)
  }

  async commit(id: string, now = Date.now()) {
    // All conditions are evaluated INSIDE the same D1 batch transaction as publication.
    // No read/compare/write race, even when separate Worker isolates commit concurrently.
    const result = await this.sql.batch([
      this.sql.prepare(`UPDATE quake_snapshots SET retired_at = ? WHERE snapshot_id =
        (SELECT snapshot_id FROM quake_latest WHERE id = 1) AND EXISTS (
        SELECT 1 FROM quake_snapshots n WHERE n.snapshot_id = ? AND n.status = 'staging'
        AND n.publisher_epoch = (SELECT publisher_epoch FROM quake_publisher_state WHERE id = 1)
        AND ${complete} AND NOT EXISTS (SELECT 1 FROM quake_latest l JOIN quake_snapshots o ON o.snapshot_id = l.snapshot_id
          WHERE l.id = 1 AND NOT (${key('n')} > ${key('o')} OR (${key('n')} = ${key('o')} AND ${sameSource}
            AND (n.publisher_epoch,n.publisher_sequence) > (o.publisher_epoch,o.publisher_sequence)))))`).bind(now,id),
      this.sql.prepare(`UPDATE quake_latest SET snapshot_id = ?, quake_revision = quake_revision + 1, updated_at = ?
        WHERE id = 1 AND EXISTS (SELECT 1 FROM quake_snapshots n WHERE n.snapshot_id = ? AND n.status = 'staging'
        AND n.publisher_epoch = (SELECT publisher_epoch FROM quake_publisher_state WHERE id = 1)
        AND ${complete} AND NOT EXISTS (SELECT 1 FROM quake_snapshots o WHERE o.snapshot_id = quake_latest.snapshot_id
          AND NOT (${key('n')} > ${key('o')} OR (${key('n')} = ${key('o')} AND ${sameSource}
            AND (n.publisher_epoch,n.publisher_sequence) > (o.publisher_epoch,o.publisher_sequence)))))`).bind(id,now,id),
      this.sql.prepare(`UPDATE quake_snapshots SET status = 'committed', committed_at = ?
        WHERE snapshot_id = ? AND status = 'staging' AND snapshot_id = (SELECT snapshot_id FROM quake_latest WHERE id = 1)`).bind(now,id),
      this.sql.prepare(`SELECT n.*, l.quake_revision, p.publisher_epoch AS current_epoch FROM quake_snapshots n
        CROSS JOIN quake_latest l CROSS JOIN quake_publisher_state p WHERE n.snapshot_id = ? AND l.id = 1 AND p.id = 1`).bind(id),
    ])
    const row = result[3].results[0] as (Row & { current_epoch: number }) | undefined
    if (!row) throw new QuakeError('snapshot_not_found', 404)
    if (row.status !== 'committed' && row.publisher_epoch !== row.current_epoch) throw new QuakeError('publisher_fenced', 409)
    if (row.status !== 'committed') throw new QuakeError('incomplete_stale_or_fenced', 409)
    return { status: 'committed', snapshotId: id, revision: row.quake_revision }
  }

  async latestMeta() {
    const row = await this.sql.prepare(`SELECT n.*, l.quake_revision FROM quake_latest l
      LEFT JOIN quake_snapshots n ON n.snapshot_id = l.snapshot_id AND n.status = 'committed' WHERE l.id = 1`).first<Row>()
    return { revision: row?.quake_revision ?? 0, snapshot: row?.snapshot_id ? metadata(row) : null }
  }

  async latest(lang: LanguageCode) {
    // One SQL statement pins both metadata and all messages to one snapshot, even across commits/cleanup.
    const rows = await this.sql.prepare(`SELECT n.*, l.quake_revision, m.message_index, m.embeds_json FROM quake_latest l
      JOIN quake_snapshots n ON n.snapshot_id = l.snapshot_id AND n.status = 'committed'
      JOIN quake_snapshot_messages m ON m.snapshot_id = n.snapshot_id AND m.lang = ?
      WHERE l.id = 1 ORDER BY m.message_index`).bind(lang).all<Row & { message_index: number; embeds_json: string }>()
    if (!rows.results.length) return { revision: (await this.latestMeta()).revision, snapshot: null, lang, messages: [] }
    const first = rows.results[0]
    const result = { revision: first.quake_revision, snapshot: metadata(first), lang,
      messages: rows.results.map((row) => ({ messageIndex: row.message_index, embeds: JSON.parse(row.embeds_json) as Embed[] })) }
    if (encoder.encode(JSON.stringify(result)).byteLength > MAX_RESPONSE_BYTES) throw new QuakeError('response_too_large', 503)
    return result
  }

  async cleanup(now = Date.now()): Promise<void> {
    await this.sql.batch([
      this.sql.prepare(`DELETE FROM quake_snapshots WHERE snapshot_id IN (SELECT snapshot_id FROM quake_snapshots
        WHERE snapshot_id IS NOT (SELECT snapshot_id FROM quake_latest WHERE id = 1)
        AND ((status = 'staging' AND created_at < ?) OR (status = 'committed' AND retired_at < ?)) LIMIT 64)`)
        .bind(now - STAGING_RETENTION_MS,now - RETIRED_RETENTION_MS),
      this.sql.prepare(`DELETE FROM quake_publisher_leases WHERE created_at < ?
        AND publisher_epoch < (SELECT publisher_epoch FROM quake_publisher_state WHERE id = 1)`).bind(now - 7 * RETIRED_RETENTION_MS),
      this.sql.prepare('DELETE FROM quake_interactions WHERE expires_at < ?').bind(now),
    ])
  }
}
