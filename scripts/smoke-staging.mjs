const base = 'https://api-staging.eewbot.net'
const health = await fetch(`${base}/health`, { redirect: 'manual' })
if (health.status !== 200 || (await health.json()).status !== 'ok') {
  throw new Error('Staging health smoke test failed')
}
const interaction = await fetch(`${base}/interactions`, { method: 'POST', body: '{"type":1}', redirect: 'manual' })
if (interaction.status !== 401) throw new Error('Staging must reject unsigned Discord Interactions')

const paths = ['/internal', '/internal/unknown', '/internal/v2/config/revision', '/internal/v2/config/snapshot']
async function assertDenied(path, headers) {
  const response = await fetch(`${base}${path}`, { headers, redirect: 'manual' })
  // Access may deny/redirect before invoking the Worker. The Worker itself uses
  // 403 or (for missing configuration) 503. Never follow an Access login redirect.
  if (![301, 302, 303, 307, 308, 401, 403, 503].includes(response.status)) {
    throw new Error('Staging internal API did not deny unauthenticated/invalid access')
  }
  const body = await response.text()
  if (
    /"(?:destinations|webhook|webhookUrl|webhookId|revision)"|https:\/\/(?:[^/]+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(
      body,
    )
  ) {
    throw new Error('Staging denied response exposed internal configuration')
  }
  // Only Worker JSON responses have our contract; Access owns its own responses.
  if (
    response.headers.get('Content-Type')?.includes('application/json') &&
    response.headers.get('Cache-Control') !== 'no-store'
  ) {
    throw new Error('Staging internal Worker error must disable caching')
  }
}
for (const path of paths) await assertDenied(path)
await assertDenied('/internal/v2/config/snapshot', {
  'CF-Access-Client-Id': 'synthetic-invalid-client-id',
  'CF-Access-Client-Secret': 'synthetic-invalid-client-secret',
  'Cf-Access-Jwt-Assertion': 'synthetic.invalid.jwt',
  'X-Authenticated-User': 'synthetic-core',
})
console.log('Staging health, unsigned Interactions and internal denial smoke tests passed')

const clientId = process.env.ACCESS_CLIENT_ID
const clientSecret = process.env.ACCESS_CLIENT_SECRET
if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('Both Access service credentials are required')
if (clientId && clientSecret) {
  const headers = { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret }
  async function read(path) {
    const response = await fetch(`${base}${path}`, { headers, redirect: 'manual' })
    if (response.status !== 200 || response.headers.get('Cache-Control') !== 'no-store') {
      throw new Error('Staging authenticated internal read failed')
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
    throw new Error('Staging internal revision/snapshot contract mismatch')
  }
  // Do not print bodies, credentials, JWTs, webhook URLs or destination counts.
  console.log('Staging authenticated internal read smoke tests passed')
} else {
  console.log('Authenticated internal reads skipped: service credentials not supplied')
}
