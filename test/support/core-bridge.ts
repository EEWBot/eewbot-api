// Test-only loopback adapter. Never use this entrypoint in Wrangler deployments.
// Production still requires Workers' native Access context, without header trust.
import app from '../../src/index'
import type { Bindings } from '../../src/env'

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    if (request.headers.get('CF-Access-Client-Id') === 'synthetic-core-id'
      && request.headers.get('CF-Access-Client-Secret') === 'synthetic-core-secret') {
      const trustedContext = {
        waitUntil: ctx.waitUntil.bind(ctx), passThroughOnException: ctx.passThroughOnException.bind(ctx),
        props: ctx.props, access: { aud: 'synthetic-core-aud' },
      }
      return app.fetch(request, env, trustedContext)
    }
    return app.fetch(request, env, ctx)
  },
}
