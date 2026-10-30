import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { isLanguageCode, type LanguageCode } from '../i18n/languages'
import type {
  DestinationChange,
  DestinationStore,
  LanguageSessionGuard,
  SettingsSessionGuard,
  VersionedDestination,
} from './destination-store'
import type {
  Destination,
  DestinationFlags,
  DestinationSnapshot,
  DestinationTarget,
  Intensity,
  Snowflake,
} from './destination-types'
import { assertIntensity, assertSnowflake, assertWebhook, booleanToSql } from './destination-validation'
import { StorageError, storage } from './storage-error'

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

const CURRENT_REVISION = '(SELECT channels_revision FROM config_meta WHERE id = 1)'

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

/** A LEFT JOIN against config_meta yields NULL destination columns when absent. */
type RevisionRow = Omit<DestinationRow, 'target_id'> & { target_id: string | null; channels_revision: number }

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
    webhook:
      row.webhook_id !== null && row.webhook_token !== null
        ? Object.freeze({ id: row.webhook_id, token: row.webhook_token })
        : null,
  })
}

function assertTarget(target: DestinationTarget): void {
  assertSnowflake(target.targetId)
  assertSnowflake(target.channelId)
  assertSnowflake(target.guildId)
  if (target.threadId !== null) assertSnowflake(target.threadId)
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid revision')
}

function uniqueSnowflakes(ids: readonly Snowflake[]): string {
  ids.forEach(assertSnowflake)
  return JSON.stringify([...new Set(ids)])
}

export class D1DestinationStore implements DestinationStore {
  constructor(private readonly db: D1Database) {}

  async getRevision(): Promise<number> {
    return storage(async () => {
      const revision = await this.db
        .prepare('SELECT channels_revision FROM config_meta WHERE id = 1')
        .first<number>('channels_revision')
      if (revision === null) throw new StorageError()
      return revision
    })
  }

  async loadSnapshot(): Promise<DestinationSnapshot> {
    return storage(async () => {
      // Do not split into independent reads: the revision could get ahead of the data.
      const { results } = await this.db
        .prepare(
          `SELECT m.channels_revision, ${COLUMNS} FROM config_meta m
           LEFT JOIN destinations d ON 1 = 1 WHERE m.id = 1 ORDER BY d.target_id`,
        )
        .all<RevisionRow>()
      const first = results[0]
      if (!first) throw new StorageError()
      const destinations = results.flatMap((row) =>
        row.target_id === null ? [] : [toDestination(row as DestinationRow)],
      )
      return Object.freeze({ revision: first.channels_revision, destinations: Object.freeze(destinations) })
    })
  }

  async getDestination(targetId: Snowflake): Promise<Destination | null> {
    return (await this.getVersionedDestination(targetId)).destination
  }

  async getVersionedDestination(targetId: Snowflake): Promise<VersionedDestination> {
    assertSnowflake(targetId)
    return storage(async () => {
      const row = await this.db
        .prepare(
          `SELECT m.channels_revision, ${COLUMNS} FROM config_meta m
           LEFT JOIN destinations d ON d.target_id = ? WHERE m.id = 1`,
        )
        .bind(targetId)
        .first<RevisionRow>()
      if (!row) throw new StorageError()
      return {
        revision: row.channels_revision,
        destination: row.target_id === null ? null : toDestination(row as DestinationRow),
      }
    })
  }

  async insertDestinationIfAbsent(target: DestinationTarget): Promise<number> {
    assertTarget(target)
    // Column defaults supply flags, minimum intensity and language.
    return this.write(
      `INSERT INTO destinations (target_id, guild_id, channel_id, thread_id)
       VALUES (?, ?, ?, ?) ON CONFLICT (target_id) DO NOTHING`,
      [target.targetId, target.guildId, target.channelId, target.threadId],
    )
  }

  async changeIfRevision(
    target: DestinationTarget,
    revision: number,
    change: DestinationChange,
    session?: SettingsSessionGuard,
    now = Date.now(),
  ): Promise<number> {
    assertTarget(target)
    assertRevision(revision)
    const assignments: string[] = []
    const values: BindValue[] = []
    const guards: string[] = []
    const guardValues: BindValue[] = []
    if ('flags' in change) {
      for (const [key, value] of Object.entries(change.flags)) {
        if (!Object.hasOwn(FLAG_COLUMNS, key)) throw new TypeError('Unknown destination flag')
        assignments.push(`${FLAG_COLUMNS[key as keyof DestinationFlags]} = ?`)
        values.push(booleanToSql(value))
      }
      if (assignments.length === 0) return 0
    } else if ('minIntensity' in change) {
      assertIntensity(change.minIntensity)
      assignments.push('min_intensity = ?')
      values.push(change.minIntensity)
    } else if ('webhook' in change) {
      if (change.webhook !== null) assertWebhook(change.webhook)
      assignments.push('webhook_id = ?', 'webhook_token = ?')
      values.push(change.webhook?.id ?? null, change.webhook?.token ?? null)
      // The atomic reservation: no other destination may hold this webhook, and the
      // caller must still own the channel's setup lock.
      guards.push(
        `NOT EXISTS (SELECT 1 FROM destinations other
           WHERE other.webhook_id = ? AND other.target_id <> destinations.target_id)`,
        `EXISTS (SELECT 1 FROM discord_setup_locks l
           WHERE l.channel_id = destinations.channel_id AND l.owner = ? AND l.expires_at > ?)`,
      )
      guardValues.push(change.webhook?.id ?? null, change.lockOwner, now)
    }
    if (session) {
      assertSnowflake(session.actorId)
      guards.push(
        `EXISTS (SELECT 1 FROM discord_sessions s
           WHERE s.id = ? AND s.kind = ? AND s.actor_id = ? AND s.revision = ? AND s.expires_at > ?
             AND s.target_id = destinations.target_id AND s.guild_id = destinations.guild_id
             AND s.channel_id = destinations.channel_id)`,
      )
      guardValues.push(session.id, 'remove' in change ? 'unregister' : 'setup', session.actorId, revision, now)
    }
    const statement =
      'remove' in change ? 'DELETE FROM destinations' : `UPDATE destinations SET ${assignments.join(', ')}`
    const predicate = [
      'target_id = ? AND guild_id = ? AND channel_id = ? AND thread_id IS ?',
      `${CURRENT_REVISION} = ?`,
      ...guards,
    ].join(' AND ')
    return this.write(`${statement} WHERE ${predicate}`, [
      ...values,
      target.targetId,
      target.guildId,
      target.channelId,
      target.threadId,
      revision,
      ...guardValues,
    ])
  }

  async changeLanguageFromSession(
    target: DestinationTarget,
    session: LanguageSessionGuard,
    language: LanguageCode,
    scope: 'target' | 'guild',
    now = Date.now(),
  ): Promise<number> {
    assertTarget(target)
    assertSnowflake(session.actorId)
    assertRevision(session.revision)
    if (!isLanguageCode(language) || !isLanguageCode(session.language)) throw new TypeError('Invalid language')
    if (scope === 'guild' && language !== session.language) {
      throw new TypeError('A guild-wide change applies the session language')
    }
    const scopePredicate = scope === 'target' ? ' AND target_id = ? AND channel_id = ? AND thread_id IS ?' : ''
    const scopeValues = scope === 'target' ? [target.targetId, target.channelId, target.threadId] : []
    // The source row keeps its language during a guild-wide same-language UPDATE,
    // so this guard stays true for every row of that single SQLite statement.
    return this.write(
      `UPDATE destinations SET lang = ? WHERE guild_id = ?${scopePredicate}
         AND ${CURRENT_REVISION} = ?
         AND EXISTS (SELECT 1 FROM discord_sessions s
           JOIN destinations source ON source.target_id = s.target_id
           WHERE s.id = ? AND s.kind = 'lang' AND s.actor_id = ? AND s.guild_id = ? AND s.target_id = ?
             AND s.channel_id = ? AND s.thread_id IS ? AND s.revision = ? AND s.language = ?
             AND s.expires_at > ?
             AND source.guild_id = s.guild_id AND source.channel_id = s.channel_id
             AND source.thread_id IS s.thread_id AND source.lang = s.language)`,
      [
        language,
        target.guildId,
        ...scopeValues,
        session.revision,
        session.id,
        session.actorId,
        target.guildId,
        target.targetId,
        target.channelId,
        target.threadId,
        session.revision,
        session.language,
        now,
      ],
    )
  }

  async isWebhookExclusiveToTarget(webhookId: Snowflake, targetId: Snowflake): Promise<boolean> {
    assertSnowflake(webhookId)
    assertSnowflake(targetId)
    return storage(
      async () =>
        (await this.db
          .prepare('SELECT 1 FROM destinations WHERE webhook_id = ? AND target_id <> ? LIMIT 1')
          .bind(webhookId, targetId)
          .first()) === null,
    )
  }

  async isWebhookUnassigned(webhookId: Snowflake): Promise<boolean> {
    assertSnowflake(webhookId)
    return storage(
      async () =>
        (await this.db.prepare('SELECT 1 FROM destinations WHERE webhook_id = ? LIMIT 1').bind(webhookId).first()) ===
        null,
    )
  }

  async removeByGuildId(guildId: Snowflake): Promise<number> {
    assertSnowflake(guildId)
    return this.write('DELETE FROM destinations WHERE guild_id = ?', [guildId])
  }

  async removeDestinations(targetIds: readonly Snowflake[]): Promise<number> {
    // One bound JSON array avoids D1's parameter limit without splitting the mutation.
    return this.write('DELETE FROM destinations WHERE target_id IN (SELECT value FROM json_each(?))', [
      uniqueSnowflakes(targetIds),
    ])
  }

  async clearWebhooksByTargets(
    targets: readonly { targetId: Snowflake; expectedWebhookId: Snowflake }[],
  ): Promise<number> {
    for (const target of targets) {
      assertSnowflake(target.targetId)
      assertSnowflake(target.expectedWebhookId)
    }
    return this.write(
      `UPDATE destinations SET webhook_id = NULL, webhook_token = NULL
       WHERE EXISTS (SELECT 1 FROM json_each(?) AS t
         WHERE json_extract(t.value, '$.targetId') = destinations.target_id
           AND json_extract(t.value, '$.expectedWebhookId') = destinations.webhook_id)`,
      [JSON.stringify(targets.map(({ targetId, expectedWebhookId }) => ({ targetId, expectedWebhookId })))],
    )
  }

  async clearWebhooksByIds(webhookIds: readonly Snowflake[]): Promise<number> {
    return this.write(
      `UPDATE destinations SET webhook_id = NULL, webhook_token = NULL
       WHERE webhook_id IN (SELECT value FROM json_each(?))`,
      [uniqueSnowflakes(webhookIds)],
    )
  }

  private statement(sql: string, values: BindValue[]): D1PreparedStatement {
    const statement = this.db.prepare(sql)
    return values.length > 0 ? statement.bind(...values) : statement
  }

  /** Runs a mutation and advances the revision iff it changed rows, in one transaction. */
  private async write(sql: string, values: BindValue[]): Promise<number> {
    return storage(async () => {
      // Keep these adjacent: changes() refers to the immediately preceding DML.
      const [mutation] = await this.db.batch([
        this.statement(sql, values),
        this.db.prepare(
          'UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1 AND changes() > 0',
        ),
      ])
      if (!mutation) throw new StorageError()
      return mutation.meta.changes
    })
  }
}
