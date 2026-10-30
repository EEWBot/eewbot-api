import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { storage } from '../db/storage-error'
import { RECEIPT_TTL_MS } from './constants'

/**
 * Inserts a receipt for a signed interaction ID; `changes()` is 1 only for the
 * first delivery. Exposed so composite claims can join the same D1 transaction.
 */
export function receiptInsert(db: D1Database, interactionId: string, now: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO interaction_receipts (interaction_id, expires_at) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .bind(interactionId, now + RECEIPT_TTL_MS)
}

/** Claims an interaction once, so Discord redeliveries never repeat side effects. */
export async function claimInteraction(db: D1Database, interactionId: string, now = Date.now()): Promise<boolean> {
  return storage(async () => (await receiptInsert(db, interactionId, now).run()).meta.changes === 1)
}
