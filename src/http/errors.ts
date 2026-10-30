import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { StorageError } from '../db/storage-error'
import { errorName, log } from '../log'

/** A client-visible error. `code` is a stable, secret-free machine-readable string. */
export class ApiError extends Error {
  override readonly name = 'ApiError'

  constructor(
    readonly code: string,
    readonly status: ContentfulStatusCode = 400,
    readonly headers: Record<string, string> = {},
  ) {
    super(code)
  }
}

export function errorBody(code: string) {
  return { error: { code } }
}

export function errorResponse(
  c: Context,
  code: string,
  status: ContentfulStatusCode,
  headers: Record<string, string> = {},
) {
  return c.json(errorBody(code), status, { 'Cache-Control': 'no-store', ...headers })
}

/**
 * Shared onError for every internal sub-app. Never returns or logs the caught
 * error itself: it may contain SQL, bound webhook credentials or request data.
 */
export function internalErrorHandler(error: Error, c: Context) {
  if (error instanceof ApiError) return errorResponse(c, error.code, error.status, error.headers)
  if (error instanceof StorageError) return errorResponse(c, 'storage_unavailable', 503)
  log.error('internal_unhandled_error', { method: c.req.method, path: c.req.path, error: errorName(error) })
  return errorResponse(c, 'internal_error', 500)
}
