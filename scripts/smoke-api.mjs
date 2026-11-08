import { fileURLToPath } from 'node:url'

const BASES = { staging: 'https://api-staging.eewbot.net', production: 'https://api.eewbot.net' }
const PATHS = [
  '/internal',
  '/internal/',
  '/internal/unknown',
  '/internal/v2/config/revision',
  '/internal/v2/config/snapshot',
]
const DENIED = [301, 302, 303, 307, 308, 401, 403]

// Fixed origins and manual redirects keep service credentials on the selected host.
// Never log response bodies, destination counts, credentials or caught fetch errors.
export async function smokeApi(environment, options = {}) {
  const base = BASES[environment]
  if (!base) throw new Error('Select staging or production explicitly')
  const { clientId, clientSecret, fetchImpl = fetch, log = console.log } = options
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('Both Access service credentials are required')
  if (environment === 'production' && (!clientId || !clientSecret)) {
    throw new Error('Production smoke tests require production Access service credentials')
  }
  const request = (origin, path, init = {}) =>
    fetchImpl(`${origin}${path}`, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) })

  const health = await request(base, '/health')
  if (health.status !== 200 || (await health.json()).status !== 'ok') throw new Error('Health smoke test failed')
  const interaction = await request(base, '/interactions', { method: 'POST', body: '{"type":1}' })
  if (interaction.status !== 401) throw new Error('Unsigned Discord Interactions must be rejected')

  async function assertDenied(origin, path, headers, allowUnconfigured = false) {
    const response = await request(origin, path, { headers })
    // Staging retains its existing fail-closed setup check. A production release
    // must have working Access: a 503 cannot count as a successful auth check.
    if (!DENIED.includes(response.status) && !(allowUnconfigured && response.status === 503)) {
      throw new Error('Internal API did not deny unauthenticated/invalid access')
    }
    const body = await response.text()
    if (
      /"(?:destinations|webhook|webhookUrl|webhookId|revision)"|https:\/\/(?:[^/]+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(
        body,
      )
    ) {
      throw new Error('Denied response exposed internal configuration')
    }
    if (
      response.headers.get('Content-Type')?.includes('application/json') &&
      response.headers.get('Cache-Control') !== 'no-store'
    ) {
      throw new Error('Internal Worker error must disable caching')
    }
  }
  for (const path of PATHS) await assertDenied(base, path, undefined, environment === 'staging')
  await assertDenied(
    base,
    '/internal/v2/config/snapshot',
    {
      'CF-Access-Client-Id': 'synthetic-invalid-client-id',
      'CF-Access-Client-Secret': 'synthetic-invalid-client-secret',
      'Cf-Access-Jwt-Assertion': 'synthetic.invalid.jwt',
      'X-Authenticated-User': 'synthetic-core',
    },
    environment === 'staging',
  )
  log(`${environment}: health, unsigned Interactions and internal denial smoke tests passed`)

  if (!clientId || !clientSecret) {
    log('Authenticated internal reads skipped: service credentials not supplied')
    return
  }
  const headers = { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret }
  async function read(path) {
    const response = await request(base, path, { headers })
    if (response.status !== 200 || response.headers.get('Cache-Control') !== 'no-store') {
      throw new Error('Authenticated internal read failed')
    }
    return response.json()
  }
  const revision = await read('/internal/v2/config/revision')
  const snapshot = await read('/internal/v2/config/snapshot')
  if (
    !Number.isSafeInteger(revision.revision) ||
    revision.revision < 0 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < revision.revision ||
    !Array.isArray(snapshot.destinations)
  ) {
    throw new Error('Internal revision/snapshot contract mismatch')
  }
  log(`${environment}: authenticated internal read smoke tests passed`)

  if (environment === 'production') {
    await assertDenied(BASES.staging, '/internal/v2/config/snapshot', headers)
    log('Production Access service credentials were denied by staging')
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await smokeApi(process.argv[2], {
      clientId: process.env.ACCESS_CLIENT_ID,
      clientSecret: process.env.ACCESS_CLIENT_SECRET,
    })
  } catch {
    console.error('API smoke tests failed; verify environment, Access policy, secrets and deployment')
    process.exitCode = 1
  }
}
