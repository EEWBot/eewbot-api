import { Hono } from 'hono'
import { dispatch } from './discord/router'
import { verifyInteractionRequest } from './discord/verify'
import type { Bindings } from './env'
import { errorBody } from './http/errors'
import { errorName, log } from './log'
import internal from './routes/internal'

export const app = new Hono<{ Bindings: Bindings }>()

app.route('/internal', internal)

app.get('/health', (c) => c.json({ status: 'ok' }))

// Discord's Interactions Endpoint URL. Every request, including PING, is
// signature-verified over the raw body before it is parsed or processed.
app.post('/interactions', async (c) => {
  c.header('Cache-Control', 'no-store')
  const publicKey = c.env.DISCORD_PUBLIC_KEY
  if (!publicKey) return c.json(errorBody('not_configured'), 503)

  const verified = await verifyInteractionRequest(c.req.raw, publicKey)
  if (!verified.ok) return c.json(errorBody(verified.error), verified.status)

  // Lazy: Hono throws on executionCtx access without a runtime context.
  const response = await dispatch(verified.interaction, c.env, () => c.executionCtx)
  if (!response) return c.json(errorBody('unsupported_interaction_type'), 400)
  return c.json(response)
})

app.notFound((c) => c.json(errorBody('not_found'), 404))

app.onError((error, c) => {
  log.error('unhandled_error', { method: c.req.method, path: c.req.path, error: errorName(error) })
  return c.json(errorBody('internal_error'), 500)
})

export default app
