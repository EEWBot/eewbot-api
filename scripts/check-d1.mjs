// Refuses remote migration/deployment until the environment's D1 binding names
// the expected database and a real database_id (not the placeholder).
// Usage: node scripts/check-d1.mjs <staging|production>
import { fileURLToPath } from 'node:url'
import { unstable_readConfig } from 'wrangler'

const EXPECTED_DATABASES = { staging: 'eewbot-staging-v2', production: 'eewbot-production' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function databaseId(env) {
  const expected = EXPECTED_DATABASES[env]
  if (!expected) throw new Error(`Unknown environment: ${env}`)
  const config = unstable_readConfig({ config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), env })
  const db = config.d1_databases.find((entry) => entry.binding === 'DB')
  if (db?.database_name !== expected || !UUID.test(db?.database_id ?? '')) {
    throw new Error(`Configure the actual Cloudflare ${expected} database_id in wrangler.jsonc before remote use`)
  }
  return db.database_id
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.argv[2]
  try {
    databaseId(env)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
