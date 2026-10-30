import type { D1Database } from '@cloudflare/workers-types'
import type { Bindings } from '../env'
import { ApiError } from '../http/errors'

/** The D1 binding, or a 503 when it is missing or cannot be accessed. */
export function requireDb(env: Bindings): D1Database {
  let db: D1Database | undefined
  try {
    db = env.DB
  } catch {
    db = undefined
  }
  if (!db) throw new ApiError('storage_unavailable', 503)
  return db
}
