import type { D1Database } from '@cloudflare/workers-types'
import { storage } from './db/storage-error'
import { TESTMESSAGE_LIMITS } from './discord/testmessage-command'
import { QuakeStore } from './quakeinfo/store'

/**
 * Purges expired ephemeral rows. Request paths only read rows that are still
 * live, so this is housekeeping for storage size, not for correctness.
 */
export async function purgeExpired(db: D1Database, now = Date.now()): Promise<void> {
  await storage(() =>
    db.batch([
      db.prepare('DELETE FROM interaction_receipts WHERE expires_at <= ?').bind(now),
      db.prepare('DELETE FROM discord_sessions WHERE expires_at <= ?').bind(now),
      db.prepare('DELETE FROM discord_setup_locks WHERE expires_at <= ?').bind(now),
      db
        .prepare('DELETE FROM discord_testmessage_runs WHERE issued_at <= ?')
        .bind(now - TESTMESSAGE_LIMITS.guildWindowMs),
    ]),
  )
  await storage(() => new QuakeStore(db).cleanup(now))
}
