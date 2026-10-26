import type { D1Database } from '@cloudflare/workers-types'
import { DestinationStorageError } from '../db/d1-destination-store'
import type { Session, Target } from './types'

export const SESSION_SECONDS = 10 * 60
// Longer than the complete bounded background operation, including cleanup.
export const LOCK_SECONDS = 120

export class DiscordState {
  constructor(private readonly db: D1Database) {}

  async claimInteraction(id: string): Promise<boolean> {
    return this.safe(async () => {
      const [, inserted] = await this.db.batch([
        this.db.prepare('DELETE FROM discord_interaction_receipts WHERE expires_at <= unixepoch()'),
        this.db.prepare(`INSERT INTO discord_interaction_receipts (id, expires_at)
          VALUES (?, unixepoch() + 1200) ON CONFLICT(id) DO NOTHING`).bind(id),
      ])
      return inserted.meta.changes === 1
    })
  }

  async createSession(actorId: string, target: Target, revision: number, kind: Session['kind']): Promise<string> {
    const id = crypto.randomUUID().replaceAll('-', '')
    return this.safe(async () => {
      await this.db.batch([
        this.db.prepare('DELETE FROM discord_sessions WHERE expires_at <= unixepoch()'),
        this.db.prepare(`INSERT INTO discord_sessions
          (id, actor_id, guild_id, target_id, channel_id, revision, kind, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch() + ?)`)
          .bind(id, actorId, target.guildId, target.targetId, target.channelId, revision, kind, SESSION_SECONDS),
      ])
      return id
    })
  }

  async session(id: string): Promise<Session | null> {
    return this.safe(() => this.db.prepare('SELECT * FROM discord_sessions WHERE id = ? AND expires_at > unixepoch()')
      .bind(id).first<Session>())
  }

  async lock(channelId: string, owner: string): Promise<boolean> {
    return this.safe(async () => (await this.db.prepare(`INSERT INTO discord_setup_locks (channel_id, owner, expires_at)
      VALUES (?, ?, unixepoch() + ?) ON CONFLICT(channel_id) DO UPDATE SET owner = excluded.owner,
      expires_at = excluded.expires_at WHERE discord_setup_locks.expires_at <= unixepoch()`)
      .bind(channelId, owner, LOCK_SECONDS).run()).meta.changes === 1)
  }

  async unlock(channelId: string, owner: string): Promise<void> {
    await this.safe(() => this.db.prepare('DELETE FROM discord_setup_locks WHERE channel_id = ? AND owner = ?')
      .bind(channelId, owner).run())
  }

  private async safe<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn() } catch { throw new DestinationStorageError() }
  }
}
