import type { ExecutionContext as WorkersExecutionContext } from '@cloudflare/workers-types'
import type { ExecutionContext } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { Bindings } from '../env'

// Hono's portable context type omits Workers' native Access property. This only
// narrows the runtime-provided context; no request header becomes trusted input.
type AccessExecutionContext = ExecutionContext & Pick<WorkersExecutionContext, 'access'>

// Authentication is independent of method/routing; a future writer policy can
// supply a separate middleware without changing the cleanup handlers or store.
export const requireAccess = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const expectedAud = c.env.ACCESS_AUD
  if (!expectedAud || expectedAud.trim().length === 0) {
    return c.json({ error: 'access_not_configured' }, 503)
  }

  let access: WorkersExecutionContext['access']
  try {
    access = (c.executionCtx as AccessExecutionContext).access
  } catch {
    // Hono throws when called without an ExecutionContext (e.g. app.request()).
    return c.json({ error: 'access_required' }, 403)
  }
  if (!access) return c.json({ error: 'access_required' }, 403)
  if (access.aud !== expectedAud) return c.json({ error: 'access_forbidden' }, 403)

  await next()
})
