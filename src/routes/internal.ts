import { Hono } from 'hono'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Bindings } from '../env'
import { errorResponse, internalErrorHandler } from '../http/errors'
import { requireAccess } from '../middleware/access-auth'
import cleanup from './cleanup'
import migration from './migration'
import quakeinfo from './quakeinfo'
import { requireDb } from './storage'

const internal = new Hono<{ Bindings: Bindings }>()
internal.onError(internalErrorHandler)

internal.use('*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'no-store')
})

// The whole internal subtree shares one Cloudflare Access boundary, enforced
// before routing, body parsing or DB access.
internal.use('*', requireAccess)

internal.get('/v2/config/revision', async (c) =>
  c.json({ revision: await new D1DestinationStore(requireDb(c.env)).getRevision() }),
)
internal.get('/v2/config/snapshot', async (c) => c.json(await new D1DestinationStore(requireDb(c.env)).loadSnapshot()))

internal.route('/v2/cleanup', cleanup)
internal.route('/v2/quakeinfo', quakeinfo)
internal.route('/v2/migration', migration)

internal.all('*', (c) => errorResponse(c, 'not_found', 404))

export default internal
