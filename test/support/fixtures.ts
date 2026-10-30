import type { D1Database } from '@cloudflare/workers-types'
import type { Destination, Intensity, WebhookCredential } from '../../src/db/destination-types'
import type { LanguageCode } from '../../src/i18n/languages'

export async function resetDb(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM destinations'),
    db.prepare('DELETE FROM testmessage_cooldowns'),
    db.prepare('DELETE FROM quake_messages'),
    db.prepare('DELETE FROM quake_latest'),
    db.prepare('UPDATE config_meta SET channels_revision = 0 WHERE id = 1'),
  ])
}

export type SeedDestination = {
  targetId: string
  channelId?: string
  threadId?: string | null
  guildId?: string | null
  eewAlert?: boolean
  eewPrediction?: boolean
  eewDecimation?: boolean
  quakeInfo?: boolean
  tsunami?: boolean
  minIntensity?: Intensity
  lang?: LanguageCode
  webhook?: WebhookCredential | null
}

/** Inserts a destination row directly and advances the revision, as a store write would. */
export async function seedDestination(db: D1Database, d: SeedDestination): Promise<Destination> {
  const row: Destination = {
    targetId: d.targetId,
    channelId: d.channelId ?? d.targetId,
    threadId: d.threadId ?? null,
    guildId: d.guildId === undefined ? null : d.guildId,
    eewAlert: d.eewAlert ?? false,
    eewPrediction: d.eewPrediction ?? false,
    eewDecimation: d.eewDecimation ?? false,
    quakeInfo: d.quakeInfo ?? false,
    tsunami: d.tsunami ?? false,
    minIntensity: d.minIntensity ?? 1,
    lang: d.lang ?? 'ja_jp',
    webhook: d.webhook ?? null,
  }
  await db.batch([
    db
      .prepare(
        `INSERT INTO destinations (target_id, guild_id, channel_id, thread_id, eew_alert, eew_prediction,
           eew_decimation, quake_info, tsunami, min_intensity, lang, webhook_id, webhook_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.targetId,
        row.guildId,
        row.channelId,
        row.threadId,
        Number(row.eewAlert),
        Number(row.eewPrediction),
        Number(row.eewDecimation),
        Number(row.quakeInfo),
        Number(row.tsunami),
        row.minIntensity,
        row.lang,
        row.webhook?.id ?? null,
        row.webhook?.token ?? null,
      ),
    db.prepare('UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1'),
  ])
  return row
}

/** Applies a raw column update and advances the revision. Columns are trusted test literals. */
export async function updateDestination(
  db: D1Database,
  targetId: string,
  columns: Record<string, string | number | null>,
): Promise<void> {
  const keys = Object.keys(columns)
  await db.batch([
    db
      .prepare(`UPDATE destinations SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE target_id = ?`)
      .bind(...keys.map((key) => columns[key] ?? null), targetId),
    db.prepare('UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1 AND changes() > 0'),
  ])
}

export async function revision(db: D1Database): Promise<number> {
  return (
    (await db.prepare('SELECT channels_revision FROM config_meta WHERE id = 1').first<number>('channels_revision')) ??
    -1
  )
}
