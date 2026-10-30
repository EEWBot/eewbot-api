import type { Context, Hono, Env as HonoEnv } from 'hono'
import { ApiError } from './errors'

type Method = 'GET' | 'POST' | 'PUT'
type RouteHandler<E extends HonoEnv> = (c: Context<E>) => Response | Promise<Response>

/**
 * Registers each method for `path` and answers every other method with 405 and
 * an Allow header. Query parameters are rejected unless listed in `query`, each
 * at most once. GET routes also serve HEAD (Hono default).
 */
export function defineRoute<E extends HonoEnv>(
  app: Hono<E>,
  path: string,
  handlers: Partial<Record<Method, RouteHandler<E>>>,
  { query = [] }: { query?: readonly string[] } = {},
): void {
  const allowed = Object.keys(handlers).join(', ')
  for (const [method, handler] of Object.entries(handlers)) {
    app.on(method, path, (c) => {
      const params = new URL(c.req.url).searchParams
      for (const key of new Set(params.keys())) {
        if (!query.includes(key) || params.getAll(key).length > 1) throw new ApiError('invalid_query')
      }
      return handler(c)
    })
  }
  app.all(path, () => {
    throw new ApiError('method_not_allowed', 405, { Allow: allowed })
  })
}
