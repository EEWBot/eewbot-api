import { Hono } from 'hono'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { DestinationConfigSource } from '../db/destination-store'
import type { Bindings } from '../env'
import { requireAccess } from '../middleware/access-auth'
import cleanup from './cleanup'
import quakeinfo from './quakeinfo'

const internal = new Hono<{ Bindings: Bindings }>()

internal.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
function isCleanupPath(path: string): boolean {
  return path === '/internal/v1/cleanup' || path.startsWith('/internal/v1/cleanup/')
}

// The whole internal subtree has one common, native Access authorization boundary.
// Authenticate before method checks, routing, body parsing or DB access.
internal.use('*', requireAccess)

internal.use('*', async (c, next) => {
  if (new URL(c.req.url).pathname !== c.req.path || c.req.path.includes('//')) {
    return c.json({ error: 'not_found' }, 404)
  }
  const quakeMethod = (c.req.method === 'POST' && /^\/internal\/v1\/quakeinfo\/(publisher\/lease|snapshots|snapshots\/[0-9a-f-]+\/commit|cleanup)$/.test(c.req.path))
    || (c.req.method === 'PUT' && /^\/internal\/v1\/quakeinfo\/snapshots\/[0-9a-f-]+\/messages\/[a-z_]+\/\d+$/.test(c.req.path))
  if (!isCleanupPath(c.req.path) && !quakeMethod && c.req.method !== 'GET') {
    c.header('Allow', 'GET')
    return c.json({ error: 'method_not_allowed' }, 405)
  }
  await next()
})

internal.route('/v1/cleanup', cleanup)
internal.route('/v1/quakeinfo', quakeinfo)

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
