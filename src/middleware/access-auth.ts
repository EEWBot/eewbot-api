import type { ExecutionContext as WorkersExecutionContext } from '@cloudflare/workers-types'
import type { ExecutionContext } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { Bindings } from '../env'
import { errorResponse } from '../http/errors'

// Hono's portable context type omits Workers' native Access property. This only
// narrows the runtime-provided context; no request header becomes trusted input.
type AccessExecutionContext = ExecutionContext & Pick<WorkersExecutionContext, 'access'>

/** Requires a native Cloudflare Access context whose AUD matches ACCESS_AUD. */
export const requireAccess = createMiddleware<{ Bindings: Bindings }>(async (c, next) => {
  const expectedAud = c.env.ACCESS_AUD?.trim()
  if (!expectedAud) return errorResponse(c, 'access_not_configured', 503)

  let access: WorkersExecutionContext['access']
  try {
    access = (c.executionCtx as AccessExecutionContext).access
  } catch {
    // Hono throws when called without an ExecutionContext (e.g. app.request()).
    return errorResponse(c, 'access_required', 403)
  }
  if (!access) return errorResponse(c, 'access_required', 403)
  if (access.aud !== expectedAud) return errorResponse(c, 'access_forbidden', 403)

  await next()
})
