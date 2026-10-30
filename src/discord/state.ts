import type { D1Database } from '@cloudflare/workers-types'
import type { Snowflake } from '../db/destination-types'
import { storage } from '../db/storage-error'
import type { LanguageCode } from '../i18n/languages'
import { SESSION_TTL_MS, SETUP_LOCK_TTL_MS } from './constants'
import type { Target } from './types'

export type SessionKind = 'setup' | 'unregister' | 'lang'

type SessionRow = {
  id: string
  kind: SessionKind
  actor_id: string
  guild_id: string
  target_id: string
  channel_id: string
  thread_id: string | null
  revision: number
  language: LanguageCode | null
  expires_at: number
}

/** A component session pins the actor, target and configuration revision a menu was rendered for. */
export type Session = {
  id: string
  kind: SessionKind
  actorId: Snowflake
  guildId: Snowflake
  targetId: Snowflake
  channelId: Snowflake
  threadId: Snowflake | null
  revision: number
  language: LanguageCode | null
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    kind: row.kind,
    actorId: row.actor_id,
    guildId: row.guild_id,
    targetId: row.target_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    revision: row.revision,
    language: row.language,
  }
}

/** Session IDs are 32 lowercase hex characters, embedded in component custom IDs. */
export function newSessionId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

/** Ephemeral Discord UI state. Expired rows are purged by the scheduled maintenance job. */
export class DiscordState {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = Date.now,
  ) {}

  async createSession(
    kind: SessionKind,
    actorId: Snowflake,
    target: Target,
    revision: number,
    language: LanguageCode | null = null,
  ): Promise<string> {
    const id = newSessionId()
    await storage(() =>
      this.db
        .prepare(
          `INSERT INTO discord_sessions
           (id, kind, actor_id, guild_id, target_id, channel_id, thread_id, revision, language, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          kind,
          actorId,
          target.guildId,
          target.targetId,
          target.channelId,
          target.threadId,
          revision,
          language,
          this.now() + SESSION_TTL_MS,
        )
        .run(),
    )
    return id
  }

  /** Returns a live session of one of the given kinds, or null. */
  async session(id: string, kinds: readonly SessionKind[]): Promise<Session | null> {
    const row = await storage(() =>
      this.db
        .prepare('SELECT * FROM discord_sessions WHERE id = ? AND expires_at > ?')
        .bind(id, this.now())
        .first<SessionRow>(),
    )
    return row && kinds.includes(row.kind) ? toSession(row) : null
  }

  /** Takes the per-channel setup lock, replacing only an expired holder. */
  async lock(channelId: Snowflake, owner: string): Promise<boolean> {
    const now = this.now()
    const result = await storage(() =>
      this.db
        .prepare(
          `INSERT INTO discord_setup_locks (channel_id, owner, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (channel_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
           WHERE discord_setup_locks.expires_at <= ?`,
        )
        .bind(channelId, owner, now + SETUP_LOCK_TTL_MS, now)
        .run(),
    )
    return result.meta.changes === 1
  }

  async unlock(channelId: Snowflake, owner: string): Promise<void> {
    await storage(() =>
      this.db
        .prepare('DELETE FROM discord_setup_locks WHERE channel_id = ? AND owner = ?')
        .bind(channelId, owner)
        .run(),
    )
  }
}
