import { Hono } from 'hono'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { DestinationConfigSource } from '../db/destination-store'
import type { Bindings } from '../env'
import { requireAccess } from '../middleware/access-auth'

const internal = new Hono<{ Bindings: Bindings }>()

internal.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})
internal.use('*', requireAccess)

// Reserve this entire boundary for read-only clients, including unknown paths.
// A future write API must use a separate authorization boundary/service token.
internal.use('*', async (c, next) => {
  if (c.req.method !== 'GET') {
    c.header('Allow', 'GET')
    return c.json({ error: 'method_not_allowed' }, 405)
  }
  await next()
})

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
