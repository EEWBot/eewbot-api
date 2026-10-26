import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import type { DestinationStore } from './destination-store'
import type {
  Destination,
  DestinationFilter,
  DestinationFlags,
  DestinationSnapshot,
  Intensity,
  NewDestination,
  Snowflake,
} from './destination-types'
import { assertIntensity, assertLanguage, assertSnowflake, booleanToSql, parseWebhookId } from './destination-validation'

const FLAG_COLUMNS = {
  eewAlert: 'eew_alert',
  eewPrediction: 'eew_prediction',
  eewDecimation: 'eew_decimation',
  quakeInfo: 'quake_info',
  tsunami: 'tsunami',
} as const

const COLUMNS = `target_id, channel_id, thread_id, guild_id,
  eew_alert, eew_prediction, eew_decimation, quake_info, tsunami,
  min_intensity, lang, webhook_url, webhook_id`

type BindValue = string | number | null
type DestinationRow = {
  target_id: string
  channel_id: string
  thread_id: string | null
  guild_id: string | null
  eew_alert: number
  eew_prediction: number
  eew_decimation: number
  quake_info: number
  tsunami: number
  min_intensity: Intensity
  lang: string
  webhook_url: string | null
  webhook_id: string | null
}

/** Intentionally omits the original D1 error/cause, which can contain bound secrets. */
export class DestinationStorageError extends Error {
  constructor() {
    super('Destination storage operation failed')
    this.name = 'DestinationStorageError'
  }
}

function toDestination(row: DestinationRow): Destination {
  return Object.freeze({
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
    webhookUrl: row.webhook_url,
    webhookId: row.webhook_id,
  })
}

export class D1DestinationStore implements DestinationStore {
  constructor(private readonly db: D1Database) {}

  async getRevision(): Promise<number> {
    return this.execute(async () => {
      const row = await this.db.prepare('SELECT channels_revision FROM config_meta WHERE id = 1')
        .first<{ channels_revision: number }>()
      if (!row) throw new DestinationStorageError()
      return row.channels_revision
    })
  }

  async getDestination(targetId: Snowflake): Promise<Destination | null> {
    assertSnowflake(targetId)
    return this.execute(async () => {
      const row = await this.db.prepare(`SELECT ${COLUMNS} FROM destinations WHERE target_id = ?`)
        .bind(targetId).first<DestinationRow>()
      return row ? toDestination(row) : null
    })
  }

  async destinationExists(targetId: Snowflake): Promise<boolean> {
    assertSnowflake(targetId)
    return this.execute(async () => (await this.db.prepare('SELECT 1 FROM destinations WHERE target_id = ?')
      .bind(targetId).first()) !== null)
  }

  async getAllDestinations(): Promise<readonly Destination[]> {
    return this.selectDestinations('1 = 1', [])
  }

  async loadSnapshot(): Promise<DestinationSnapshot> {
    return this.execute(async () => {
      // A single SQLite statement observes one committed state, including an empty DB.
      // Do not split this into independent reads (revision could get ahead of data).
      const { results } = await this.db.prepare(`
        SELECT m.channels_revision, d.* FROM config_meta m
        LEFT JOIN destinations d ON 1 = 1 WHERE m.id = 1 ORDER BY d.target_id
      `).all<DestinationRow & { channels_revision: number }>()
      if (results.length === 0) throw new DestinationStorageError()
      return Object.freeze({
        revision: results[0].channels_revision,
        destinations: Object.freeze(results.filter((row) => row.target_id !== null).map(toDestination)),
      })
    })
  }

  async getWebhookAbsentDestinations(filter: DestinationFilter = {}): Promise<readonly Destination[]> {
    const predicates = ['webhook_url IS NULL']
    const values: BindValue[] = []
    for (const [key, column] of Object.entries(FLAG_COLUMNS)) {
      const flag = filter[key as keyof DestinationFlags]
      if (flag !== undefined) {
        predicates.push(`${column} = ?`)
        values.push(booleanToSql(flag))
      }
    }
    for (const [key, column] of [
      ['guildId', 'guild_id'], ['channelId', 'channel_id'],
      ['threadId', 'thread_id'], ['webhookId', 'webhook_id'],
    ] as const) {
      const value = filter[key]
      if (value === undefined) continue
      if (value === null && key !== 'channelId') {
        predicates.push(`${column} IS NULL`)
      } else {
        assertSnowflake(value)
        predicates.push(`${column} = ?`)
        values.push(value)
      }
    }
    for (const [key, column] of [['hasGuild', 'guild_id'], ['isThread', 'thread_id']] as const) {
      const value = filter[key]
      if (value !== undefined && value !== null) {
        booleanToSql(value)
        predicates.push(`${column} IS ${value ? 'NOT ' : ''}NULL`)
      }
    }
    if (filter.intensity !== undefined) {
      assertIntensity(filter.intensity)
      predicates.push('min_intensity <= ?')
      values.push(filter.intensity)
    }
    return this.selectDestinations(predicates.join(' AND '), values)
  }

  async isWebhookExclusiveToTarget(webhookId: Snowflake, targetId: Snowflake): Promise<boolean> {
    assertSnowflake(webhookId)
    assertSnowflake(targetId)
    return this.execute(async () => (await this.db.prepare(`
      SELECT 1 FROM destinations WHERE webhook_id = ? AND target_id <> ? LIMIT 1
    `).bind(webhookId, targetId).first()) === null)
  }

  async insertDestinationIfAbsent(destination: NewDestination): Promise<number> {
    assertSnowflake(destination.targetId)
    assertSnowflake(destination.channelId)
    const threadId = destination.threadId ?? null
    const guildId = destination.guildId ?? null
    if (threadId !== null) assertSnowflake(threadId)
    if (guildId !== null) assertSnowflake(guildId)
    const intensity = destination.minIntensity ?? 1
    const lang = destination.lang ?? 'ja_jp'
    assertIntensity(intensity)
    assertLanguage(lang)
    const url = destination.webhookUrl ?? null
    const webhookId = url === null ? null : parseWebhookId(url)
    return this.write(`INSERT INTO destinations (${COLUMNS})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_id) DO NOTHING`, [
      destination.targetId, destination.channelId, threadId, guildId,
      ...Object.keys(FLAG_COLUMNS).map((key) => booleanToSql(destination[key as keyof DestinationFlags] ?? false)),
      intensity, lang, url, webhookId,
    ])
  }

  async removeDestination(targetId: Snowflake): Promise<number> {
    assertSnowflake(targetId)
    return this.write('DELETE FROM destinations WHERE target_id = ?', [targetId])
  }

  async removeDestinations(targetIds: readonly Snowflake[]): Promise<number> {
    targetIds.forEach(assertSnowflake)
    return this.write('DELETE FROM destinations WHERE target_id IN (SELECT value FROM json_each(?))',
      [JSON.stringify([...new Set(targetIds)])])
  }

  async clearWebhooksByTargets(targets: readonly { targetId: Snowflake, expectedWebhookId: Snowflake }[]): Promise<number> {
    for (const target of targets) {
      assertSnowflake(target.targetId)
      assertSnowflake(target.expectedWebhookId)
    }
    return this.write(`UPDATE destinations SET webhook_url = NULL, webhook_id = NULL
      WHERE EXISTS (SELECT 1 FROM json_each(?) AS t
        WHERE json_extract(t.value, '$.targetId') = destinations.target_id
          AND json_extract(t.value, '$.expectedWebhookId') = destinations.webhook_id)`, [JSON.stringify(targets)])
  }

  async clearWebhooksByIds(webhookIds: readonly Snowflake[]): Promise<number> {
    webhookIds.forEach(assertSnowflake)
    return this.write(`UPDATE destinations SET webhook_url = NULL, webhook_id = NULL
      WHERE webhook_id IN (SELECT value FROM json_each(?))`, [JSON.stringify([...new Set(webhookIds)])])
  }

  async setFlags(targetId: Snowflake, flags: Partial<DestinationFlags>): Promise<number> {
    assertSnowflake(targetId)
    const assignments: string[] = []
    const values: BindValue[] = []
    for (const [key, value] of Object.entries(flags)) {
      if (!Object.hasOwn(FLAG_COLUMNS, key)) throw new TypeError('Unknown destination flag')
      assignments.push(`${FLAG_COLUMNS[key as keyof DestinationFlags]} = ?`)
      values.push(booleanToSql(value))
    }
    if (assignments.length === 0) return 0
    return this.write(`UPDATE destinations SET ${assignments.join(', ')} WHERE target_id = ?`, [...values, targetId])
  }

  async setMinIntensity(targetId: Snowflake, intensity: Intensity): Promise<number> {
    assertSnowflake(targetId)
    assertIntensity(intensity)
    return this.write('UPDATE destinations SET min_intensity = ? WHERE target_id = ?', [intensity, targetId])
  }

  async setWebhook(targetId: Snowflake, url: string | null): Promise<number> {
    assertSnowflake(targetId)
    const id = url === null ? null : parseWebhookId(url)
    return this.write('UPDATE destinations SET webhook_url = ?, webhook_id = ? WHERE target_id = ?', [url, id, targetId])
  }

  async setLanguage(targetId: Snowflake, lang: string): Promise<number> {
    assertSnowflake(targetId)
    assertLanguage(lang)
    return this.write('UPDATE destinations SET lang = ? WHERE target_id = ?', [lang, targetId])
  }

  async removeByGuildId(guildId: Snowflake): Promise<number> {
    assertSnowflake(guildId)
    return this.write('DELETE FROM destinations WHERE guild_id = ?', [guildId])
  }

  async setLanguageByGuildId(guildId: Snowflake, lang: string): Promise<number> {
    assertSnowflake(guildId)
    assertLanguage(lang)
    return this.write('UPDATE destinations SET lang = ? WHERE guild_id = ?', [lang, guildId])
  }

  async clearWebhookByUrls(urls: readonly string[]): Promise<number> {
    const ids = new Set<Snowflake>()
    for (const url of urls) {
      try {
        ids.add(parseWebhookId(url))
      } catch {
        // Java cleanup ignores invalid URLs. Never log token-bearing input/errors.
      }
    }
    if (ids.size === 0) return 0
    // One bound JSON array avoids D1's parameter limit without splitting the mutation.
    return this.write(`UPDATE destinations SET webhook_url = NULL, webhook_id = NULL
      WHERE webhook_id IN (SELECT value FROM json_each(?))`, [JSON.stringify([...ids])])
  }

  private async selectDestinations(predicate: string, values: BindValue[]): Promise<readonly Destination[]> {
    return this.execute(async () => {
      const { results } = await this.statement(`SELECT ${COLUMNS} FROM destinations WHERE ${predicate} ORDER BY target_id`, values)
        .all<DestinationRow>()
      return Object.freeze(results.map(toDestination))
    })
  }

  private statement(sql: string, values: BindValue[]): D1PreparedStatement {
    const statement = this.db.prepare(sql)
    return values.length > 0 ? statement.bind(...values) : statement
  }

  private async write(sql: string, values: BindValue[]): Promise<number> {
    return this.execute(async () => {
      // Keep these statements adjacent: changes() belongs to the preceding DML.
      // D1 batch is a transaction, so concurrent requests cannot interleave here.
      // Same-value UPDATEs count matched rows; bulk writes still increment only once.
      const [mutation] = await this.db.batch([
        this.statement(sql, values),
        this.db.prepare(`UPDATE config_meta SET channels_revision = channels_revision + 1
          WHERE id = 1 AND changes() > 0`),
      ])
      return mutation.meta.changes
    })
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch {
      throw new DestinationStorageError()
    }
  }
}
