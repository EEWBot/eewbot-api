import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { LanguageCode } from '../i18n/languages'
import type {
  Destination,
  DestinationFlags,
  DestinationSnapshot,
  DestinationTarget,
  Intensity,
  Snowflake,
  WebhookCredential,
} from './destination-types'
import { StorageError, storage } from './storage-error'

export type DestinationChange =
  | { flags: Partial<DestinationFlags> }
  | { minIntensity: Intensity }
  | { webhook: WebhookCredential | null }
  | { lang: LanguageCode }

const FLAG_COLUMNS = {
  eewAlert: 'eew_alert',
  eewPrediction: 'eew_prediction',
  eewDecimation: 'eew_decimation',
  quakeInfo: 'quake_info',
  tsunami: 'tsunami',
} as const satisfies Record<keyof DestinationFlags, string>

const COLUMNS = `d.target_id, d.guild_id, d.channel_id, d.thread_id,
  d.eew_alert, d.eew_prediction, d.eew_decimation, d.quake_info, d.tsunami,
  d.min_intensity, d.lang, d.webhook_id, d.webhook_token`

/** Matches a row on its full Discord identity, so a moved thread never matches. */
const SAME_TARGET = 'target_id = ? AND guild_id = ? AND channel_id = ? AND thread_id IS ?'

type BindValue = string | number | null

type DestinationRow = {
  target_id: string
  guild_id: string | null
  channel_id: string
  thread_id: string | null
  eew_alert: number
  eew_prediction: number
  eew_decimation: number
  quake_info: number
  tsunami: number
  min_intensity: Intensity
  lang: LanguageCode
  webhook_id: string | null
  webhook_token: string | null
}

/** A LEFT JOIN against config_meta yields NULL destination columns when there are no rows. */
type SnapshotRow = Omit<DestinationRow, 'target_id'> & { target_id: string | null; channels_revision: number }

function toDestination(row: DestinationRow): Destination {
  return {
    targetId: row.target_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    guildId: row.guild_id,
    eewAlert: row.eew_alert === 1,
    eewPrediction: row.eew_prediction === 1,
    eewDecimation: row.eew_decimation === 1,
    quakeInfo: row.quake_info === 1,
    tsunami: row.tsunami === 1,
    minIntensity: row.min_intensity,
    lang: row.lang,
    webhook:
      row.webhook_id !== null && row.webhook_token !== null ? { id: row.webhook_id, token: row.webhook_token } : null,
  }
}

function targetValues(target: DestinationTarget): BindValue[] {
  return [target.targetId, target.guildId, target.channelId, target.threadId]
}

/**
 * Delivery configuration. Every mutation that changes at least one row advances
 * `channels_revision` exactly once, in the same transaction; Core polls it.
 */
export class D1DestinationStore {
  constructor(private readonly db: D1Database) {}

  async getRevision(): Promise<number> {
    const revision = await storage(() =>
      this.db.prepare('SELECT channels_revision FROM config_meta WHERE id = 1').first<number>('channels_revision'),
    )
    if (revision === null) throw new StorageError()
    return revision
  }

  /** One SQL statement, so the revision always matches the rows. */
  async loadSnapshot(): Promise<DestinationSnapshot> {
    const { results } = await storage(() =>
      this.db
        .prepare(
          `SELECT m.channels_revision, ${COLUMNS} FROM config_meta m
           LEFT JOIN destinations d ON 1 = 1 WHERE m.id = 1 ORDER BY d.target_id`,
        )
        .all<SnapshotRow>(),
    )
    const first = results[0]
    if (!first) throw new StorageError()
    return {
      revision: first.channels_revision,
      destinations: results.flatMap((row) => (row.target_id === null ? [] : [toDestination(row as DestinationRow)])),
    }
  }

  async getDestination(targetId: Snowflake): Promise<Destination | null> {
    const row = await storage(() =>
      this.db
        .prepare(`SELECT ${COLUMNS} FROM destinations d WHERE d.target_id = ?`)
        .bind(targetId)
        .first<DestinationRow>(),
    )
    return row ? toDestination(row) : null
  }

  /** Inserts the target with column defaults; never overwrites. */
  insertIfAbsent(target: DestinationTarget): Promise<number> {
    return this.write(
      `INSERT INTO destinations (target_id, guild_id, channel_id, thread_id)
       VALUES (?, ?, ?, ?) ON CONFLICT (target_id) DO NOTHING`,
      targetValues(target),
    )
  }

  /** Changes one registered target. Returns 0 when it is not registered. */
  update(target: DestinationTarget, change: DestinationChange): Promise<number> {
    const assignments: string[] = []
    const values: BindValue[] = []
    if ('flags' in change) {
      for (const [key, value] of Object.entries(change.flags)) {
        assignments.push(`${FLAG_COLUMNS[key as keyof DestinationFlags]} = ?`)
        values.push(value ? 1 : 0)
      }
    } else if ('minIntensity' in change) {
      assignments.push('min_intensity = ?')
      values.push(change.minIntensity)
    } else if ('webhook' in change) {
      assignments.push('webhook_id = ?', 'webhook_token = ?')
      values.push(change.webhook?.id ?? null, change.webhook?.token ?? null)
    } else {
      assignments.push('lang = ?')
      values.push(change.lang)
    }
    if (assignments.length === 0) return Promise.resolve(0)
    return this.write(`UPDATE destinations SET ${assignments.join(', ')} WHERE ${SAME_TARGET}`, [
      ...values,
      ...targetValues(target),
    ])
  }

  remove(target: DestinationTarget): Promise<number> {
    return this.write(`DELETE FROM destinations WHERE ${SAME_TARGET}`, targetValues(target))
  }

  setGuildLanguage(guildId: Snowflake, lang: LanguageCode): Promise<number> {
    return this.write('UPDATE destinations SET lang = ? WHERE guild_id = ?', [lang, guildId])
  }

  removeByGuildId(guildId: Snowflake): Promise<number> {
    return this.write('DELETE FROM destinations WHERE guild_id = ?', [guildId])
  }

  /** ID lists are bound as one JSON array, avoiding D1's bound-parameter limit. */
  removeDestinations(targetIds: readonly Snowflake[]): Promise<number> {
    return this.write('DELETE FROM destinations WHERE target_id IN (SELECT value FROM json_each(?))', [
      JSON.stringify(targetIds),
    ])
  }

  /** Clears only rows whose webhook still matches, so a replacement is never cleared. */
  clearWebhooksByTargets(targets: readonly { targetId: Snowflake; expectedWebhookId: Snowflake }[]): Promise<number> {
    return this.write(
      `UPDATE destinations SET webhook_id = NULL, webhook_token = NULL
       WHERE EXISTS (SELECT 1 FROM json_each(?) AS t
         WHERE json_extract(t.value, '$.targetId') = destinations.target_id
           AND json_extract(t.value, '$.expectedWebhookId') = destinations.webhook_id)`,
      [JSON.stringify(targets)],
    )
  }

  clearWebhooksByIds(webhookIds: readonly Snowflake[]): Promise<number> {
    return this.write(
      `UPDATE destinations SET webhook_id = NULL, webhook_token = NULL
       WHERE webhook_id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(webhookIds)],
    )
  }

  private statement(sql: string, values: BindValue[]): D1PreparedStatement {
    const statement = this.db.prepare(sql)
    return values.length > 0 ? statement.bind(...values) : statement
  }

  /** Runs a mutation and advances the revision iff it changed rows, in one transaction. */
  private async write(sql: string, values: BindValue[]): Promise<number> {
    // Keep these adjacent: changes() refers to the immediately preceding statement.
    const [mutation] = await storage(() =>
      this.db.batch([
        this.statement(sql, values),
        this.db.prepare(
          'UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1 AND changes() > 0',
        ),
      ]),
    )
    if (!mutation) throw new StorageError()
    return mutation.meta.changes
  }
}
