import { Hono } from 'hono'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { DestinationConfigSource } from '../db/destination-store'
import type { Bindings } from '../env'
import { errorResponse, internalErrorHandler } from '../http/errors'
import { defineRoute } from '../http/route'
import { requireAccess } from '../middleware/access-auth'
import cleanup from './cleanup'
import quakeinfo from './quakeinfo'
import { requireDb } from './storage'

export const INTERNAL_API_VERSION = 2

const internal = new Hono<{ Bindings: Bindings }>()
internal.onError(internalErrorHandler)

internal.use('*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'no-store')
})

// The whole internal subtree shares one native Access authorization boundary,
// enforced before routing, method checks, body parsing or DB access.
internal.use('*', requireAccess)

// Reject percent-encoded or duplicated separators that the router would normalize.
internal.use('*', async (c, next) => {
  if (new URL(c.req.url).pathname !== c.req.path || c.req.path.includes('//')) {
    return errorResponse(c, 'not_found', 404)
  }
  await next()
})

function configSource(env: Bindings): DestinationConfigSource {
  return new D1DestinationStore(requireDb(env))
}

defineRoute(internal, '/v2/meta', {
  GET: (c) => c.json({ apiVersion: INTERNAL_API_VERSION, capabilities: ['configRevision', 'deliverySnapshot'] }),
})
defineRoute(internal, '/v2/config/revision', {
  GET: async (c) => c.json({ revision: await configSource(c.env).getRevision() }),
})
defineRoute(internal, '/v2/config/snapshot', {
  GET: async (c) => c.json(await configSource(c.env).loadSnapshot()),
})

internal.route('/v2/cleanup', cleanup)
internal.route('/v2/quakeinfo', quakeinfo)

internal.all('*', (c) => errorResponse(c, 'not_found', 404))

export default internal
