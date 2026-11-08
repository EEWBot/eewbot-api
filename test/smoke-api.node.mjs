import assert from 'node:assert/strict'
import { test } from 'node:test'
import { smokeApi } from '../scripts/smoke-api.mjs'

const clientId = 'synthetic-production-client'
const clientSecret = 'synthetic-production-secret'

function fixture({ anonymousStatus = 403, authenticatedStatus = 200, crossEnvironmentStatus = 403 } = {}) {
  const calls = []
  const logs = []
  const options = {
    clientId,
    clientSecret,
    log: (message) => logs.push(message),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      const path = new URL(url).pathname
      if (path === '/health') return Response.json({ status: 'ok' })
      if (path === '/interactions') return new Response(null, { status: 401 })
      const authenticated = init.headers?.['CF-Access-Client-Id'] === clientId
      const status = !authenticated
        ? anonymousStatus
        : new URL(url).hostname === 'api-staging.eewbot.net'
          ? crossEnvironmentStatus
          : authenticatedStatus
      const body =
        status !== 200
          ? { error: { code: 'access_required' } }
          : path.endsWith('/revision')
            ? { revision: 0 }
            : { revision: 0, destinations: [{ webhook: { token: 'synthetic-private-webhook' } }] }
      return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
    },
  }
  return { options, calls, logs }
}

test('production requires both service credentials before making any requests', async () => {
  for (const credentials of [{}, { clientId }, { clientSecret }]) {
    const { options, calls } = fixture()
    await assert.rejects(
      smokeApi('production', { ...options, clientId: undefined, clientSecret: undefined, ...credentials }),
    )
    assert.equal(calls.length, 0)
  }
})

test('requires an explicit known environment', async () => {
  const { options, calls } = fixture()
  for (const environment of [undefined, '', 'prod', 'https://other.example.com']) {
    await assert.rejects(smokeApi(environment, options))
  }
  assert.equal(calls.length, 0)
})

test('production checks anonymous denial, authenticated reads and rejection by staging without exposing secrets', async () => {
  const { options, calls, logs } = fixture()
  await smokeApi('production', options)
  assert.ok(calls.some(({ url }) => url.endsWith('/internal')))
  assert.ok(calls.some(({ url }) => url.endsWith('/internal/')))
  assert.equal(calls.at(-1).url, 'https://api-staging.eewbot.net/internal/v2/config/snapshot')
  assert.equal(calls.at(-1).init.headers['CF-Access-Client-Secret'], clientSecret)
  assert.ok(calls.every(({ init }) => init.redirect === 'manual' && init.signal instanceof AbortSignal))
  const unsigned = calls.find(({ url }) => url.endsWith('/interactions'))
  assert.equal(unsigned.init.method, 'POST')
  const forged = calls.find(({ init }) => init.headers?.['Cf-Access-Jwt-Assertion'])
  assert.ok(forged)
  const output = logs.join('\n')
  for (const secret of [clientId, clientSecret, 'synthetic-private-webhook']) assert.ok(!output.includes(secret))
})

test('a fail-closed but unconfigured 503 cannot pass a production release check', async () => {
  const { options } = fixture({ anonymousStatus: 503 })
  await assert.rejects(smokeApi('production', options), /did not deny/)
})

test('an exposed anonymous snapshot fails the release check', async () => {
  const { options } = fixture({ anonymousStatus: 200 })
  await assert.rejects(smokeApi('production', options), /did not deny/)
})

test('staging retains optional credentials and fail-closed setup checks', async () => {
  const { options, calls, logs } = fixture({ anonymousStatus: 503 })
  await smokeApi('staging', { ...options, clientId: undefined, clientSecret: undefined })
  assert.ok(logs.some((message) => message.includes('skipped')))
  assert.ok(calls.every(({ url }) => new URL(url).hostname === 'api-staging.eewbot.net'))
})

test('production credentials accepted by staging fail the separation check', async () => {
  const { options } = fixture({ crossEnvironmentStatus: 200 })
  await assert.rejects(smokeApi('production', options), /did not deny/)
})

test('unavailable staging cannot count as evidence that production credentials are rejected', async () => {
  const { options } = fixture({ crossEnvironmentStatus: 503 })
  await assert.rejects(smokeApi('production', options), /did not deny/)
})

test('authenticated redirects and unavailable internal reads fail without following redirects', async () => {
  for (const authenticatedStatus of [302, 403, 503]) {
    const { options, calls } = fixture({ authenticatedStatus })
    await assert.rejects(smokeApi('production', options), /Authenticated internal read failed/)
    assert.ok(calls.every(({ init }) => init.redirect === 'manual'))
  }
})
