import { Hono } from 'hono'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { DestinationConfigSource } from '../db/destination-store'
import type { Bindings } from '../env'
import { requireAccess, requireCleanupAccess } from '../middleware/access-auth'
import cleanup from './cleanup'

const internal = new Hono<{ Bindings: Bindings }>()

internal.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
function isCleanupPath(path: string): boolean {
  return path === '/internal/v1/cleanup' || path.startsWith('/internal/v1/cleanup/')
}

// Select authorization before routing, including unknown routes and methods.
// Only literal canonical cleanup paths can reach the write router.
internal.use('*', (c, next) => isCleanupPath(c.req.path)
  ? requireCleanupAccess(c, next) : requireAccess(c, next))

internal.use('*', async (c, next) => {
  if (new URL(c.req.url).pathname !== c.req.path || c.req.path.includes('//')) {
    return c.json({ error: 'not_found' }, 404)
  }
  if (!isCleanupPath(c.req.path) && c.req.method !== 'GET') {
    c.header('Allow', 'GET')
    return c.json({ error: 'method_not_allowed' }, 405)
  }
  await next()
})

internal.route('/v1/cleanup', cleanup)

internal.get('/v1/meta', (c) => c.json({
  apiVersion: 1,
  capabilities: ['configRevision', 'deliverySnapshot'],
}))

internal.get('/v1/config/revision', async (c) => {
  if (!c.env.DB) return c.json({ error: 'storage_unavailable' }, 503)
  const source: DestinationConfigSource = new D1DestinationStore(c.env.DB)
  return c.json({ revision: await source.getRevision() })
})

internal.get('/v1/config/snapshot', async (c) => {
  if (!c.env.DB) return c.json({ error: 'storage_unavailable' }, 503)
  const source: DestinationConfigSource = new D1DestinationStore(c.env.DB)
  return c.json(await source.loadSnapshot())
})

internal.all('*', (c) => c.json({ error: 'not_found' }, 404))

// Never log/return an underlying error: it may contain SQL, bound webhook
// credentials or request details. Also prevent Hono's default error logging.
internal.onError((_error, c) => c.json({ error: 'storage_unavailable' }, 503, {
  'Cache-Control': 'no-store',
}))

export default internal
