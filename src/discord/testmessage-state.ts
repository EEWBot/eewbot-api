import type { D1Database } from '@cloudflare/workers-types'
import { DestinationStorageError } from '../db/d1-destination-store'
import type { Target } from './types'

/** All gates and the replay receipt commit in one serialized D1 batch. */
export class TestMessageState {
  constructor(private readonly db: D1Database) {}

  async claim(id: string, actorId: string, target: Target): Promise<'granted' | 'duplicate' | 'limited'> {
    try {
      const [, , receipt, grant] = await this.db.batch([
        this.db.prepare('DELETE FROM discord_interaction_receipts WHERE expires_at <= unixepoch()'),
        this.db.prepare('DELETE FROM discord_testmessage_runs WHERE issued_at <= unixepoch() - 600'),
        this.db.prepare(`INSERT INTO discord_interaction_receipts (id, expires_at)
          VALUES (?, unixepoch() + 1200) ON CONFLICT(id) DO NOTHING`).bind(id),
        // changes() is the immediately preceding receipt INSERT in this transaction.
        this.db.prepare(`INSERT INTO discord_testmessage_runs (interaction_id, actor_id, target_id, guild_id, issued_at)
          SELECT ?, ?, ?, ?, unixepoch() WHERE changes() = 1
          AND NOT EXISTS (SELECT 1 FROM discord_testmessage_runs WHERE target_id = ? AND issued_at > unixepoch() - 30)
          AND NOT EXISTS (SELECT 1 FROM discord_testmessage_runs WHERE actor_id = ? AND issued_at > unixepoch() - 60)
          AND (SELECT count(*) FROM discord_testmessage_runs WHERE guild_id = ? AND issued_at > unixepoch() - 600) < 10`)
          .bind(id, actorId, target.targetId, target.guildId, target.targetId, actorId, target.guildId),
      ])
      return receipt.meta.changes !== 1 ? 'duplicate' : grant.meta.changes === 1 ? 'granted' : 'limited'
    } catch { throw new DestinationStorageError() }
  }
}
