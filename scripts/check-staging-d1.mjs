import { fileURLToPath } from 'node:url'
import { unstable_readConfig } from 'wrangler'

const config = unstable_readConfig({
  config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
  env: 'staging',
})
const databases = config.d1_databases
const db = databases.find((entry) => entry.binding === 'DB')
if (
  db?.database_name !== 'eewbot-staging' ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db?.database_id ?? '')
) {
  throw new Error('Configure the actual Cloudflare eewbot-staging database_id before remote migration/deployment')
}
