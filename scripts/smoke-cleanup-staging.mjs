// Explicit, staging-only maintenance smoke. No credentials or snapshots are printed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { stagingDatabaseId } from './check-d1.mjs'

if (process.env.EEWBOT_CLEANUP_STAGING_SMOKE !== 'true') throw new Error('Explicit staging smoke opt-in required')
const origin = 'https://api-staging.eewbot.net'
const account = 'd55aa59d80020492b1293f23ec93dd8f'
const database = stagingDatabaseId()
const cloudBase = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}`
// Reserved synthetic IDs near the top of the signed 64-bit range; never real Discord IDs.
const ids = Array.from({ length: 8 }, (_, i) => (9223372036854000101n + BigInt(i)).toString())
const guildId = '9223372036854000901'
const webhookA = '9223372036854000801'
const webhookB = '9223372036854000802'
const fixturePath = new URL('../.wrangler/cleanup-staging-fixture.json', import.meta.url)
const access = {
  'CF-Access-Client-Id': process.env.ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': process.env.ACCESS_CLIENT_SECRET,
}
assert.ok(access['CF-Access-Client-Id'] && access['CF-Access-Client-Secret'], 'Common Access credentials required')
assert.ok(process.env.CLOUDFLARE_API_TOKEN, 'D1 maintenance API credential required')

async function cloud(path, body) {
  const response = await fetch(`${cloudBase}${path}`, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (response.status !== 200) throw new Error(`Staging D1 maintenance rejected (status ${response.status})`)
  const result = await response.json()
  if (!result.success) throw new Error('Staging D1 maintenance failed (details suppressed)')
  return result.result
}
async function batch(statements) {
  const result = await cloud('/query', { batch: statements })
  if (!Array.isArray(result) || result.some((entry) => !entry.success))
    throw new Error('Staging maintenance batch failed')
  return result
}
async function api(path, body, headers = access) {
  const response = await fetch(`${origin}/internal/v2/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  assert.equal(response.status, 200, 'Authenticated staging API request must succeed')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  return response.json()
}
async function revision() {
  return (await api('config/revision')).revision
}
async function mutate(operation, body, affected) {
  const before = await revision()
  assert.deepEqual(await api(`cleanup/${operation}`, body), { affected })
  assert.equal(
    await revision(),
    before + (affected > 0 ? 1 : 0),
    'Exactly one revision increment per changed operation',
  )
}
function digest(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
const token = 'synthetic-cleanup-smoke-token'
function hook(id) {
  return { id, token }
}
function row(id, options = {}) {
  return { targetId: id, channelId: id, threadId: null, guildId: null, webhook: null, ...options }
}
async function seed(rows) {
  const before = await api('config/snapshot')
  // Check IDs/guild/webhooks before writing, and use INSERT without upsert.
  assert.ok(
    before.destinations.every(
      (d) => !ids.includes(d.targetId) && d.guildId !== guildId && ![webhookA, webhookB].includes(d.webhook?.id),
    ),
    'Reserved synthetic IDs must be absent',
  )
  await batch([
    {
      sql: `INSERT INTO destinations (target_id, channel_id, thread_id, guild_id, webhook_id, webhook_token)
      SELECT json_extract(value, '$.targetId'), json_extract(value, '$.channelId'),
        json_extract(value, '$.threadId'), json_extract(value, '$.guildId'),
        json_extract(value, '$.webhook.id'), json_extract(value, '$.webhook.token') FROM json_each(?)`,
      params: [JSON.stringify(rows)],
    },
    { sql: 'UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1 AND changes() > 0' },
  ])
  assert.equal(await revision(), before.revision + 1)
  return digest(before.destinations)
}
async function assertOriginal(hash) {
  const after = await api('config/snapshot')
  assert.equal(digest(after.destinations), hash, 'All original destinations must be preserved exactly')
  return after.revision
}

try {
  assert.equal((await cloud('')).name, 'eewbot-staging', 'Only staging D1 may be touched')
  const meta = await api('cleanup/meta')
  assert.equal(meta.apiVersion, 2)
  assert.ok(meta.capabilities.includes('destinationCleanup'))
  if (process.argv.includes('--finish-java')) {
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
    assert.deepEqual(fixture.ids, ids.slice(0, 7))
    const snapshot = await api('config/snapshot')
    const survivors = snapshot.destinations.filter((d) => fixture.ids.includes(d.targetId))
    assert.ok(
      survivors.every((d) => d.guildId === null || d.guildId === fixture.guildId),
      'Only our synthetic survivors may be deleted',
    )
    await mutate('destinations', { targetIds: fixture.ids }, survivors.length)
    console.log(
      JSON.stringify({
        phase: 'java-fixture-cleanup',
        originalDestinationsPreserved: true,
        revision: await assertOriginal(fixture.originalHash),
      }),
    )
  } else {
    const initialRevision = await revision()
    for (const headers of [
      {},
      { 'CF-Access-Client-Id': 'forged', 'CF-Access-Client-Secret': 'forged', 'Cf-Access-Jwt-Assertion': 'forged.jwt' },
    ]) {
      const denied = await fetch(`${origin}/internal/v2/cleanup/guild`, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ guildId }),
      })
      assert.ok(
        [301, 302, 303, 307, 308, 401, 403].includes(denied.status),
        'Unauthenticated/forged requests must be denied',
      )
    }
    assert.equal(await revision(), initialRevision)
    const originalHash = await seed([
      row(ids[0], { guildId }),
      row(ids[1], { guildId }),
      row(ids[2]),
      row(ids[3], { channelId: ids[2], threadId: ids[3] }),
      row(ids[4], { webhook: hook(webhookA) }),
      row(ids[5], { webhook: hook(webhookB) }),
      row(ids[6], { webhook: hook(webhookA) }),
      row(ids[7], { channelId: ids[6], threadId: ids[7], webhook: hook(webhookA) }),
    ])
    await mutate('guild', { guildId }, 2)
    await mutate('guild', { guildId }, 0)
    await mutate('destinations', { targetIds: [ids[2], ids[3], ids[2]] }, 2)
    await mutate('destinations', { targetIds: [ids[2], ids[3]] }, 0)
    await mutate('webhooks', { targets: [{ targetId: ids[5], expectedWebhookId: webhookA }] }, 0)
    await mutate('webhooks', { targets: [{ targetId: ids[4], expectedWebhookId: webhookA }] }, 1)
    await mutate('webhooks', { targets: [{ targetId: ids[4], expectedWebhookId: webhookA }] }, 0)
    const replaced = (await api('config/snapshot')).destinations.find((d) => d.targetId === ids[5])
    assert.equal(replaced.webhook?.id, webhookB, 'Delayed failure must preserve a different replacement webhook')
    await mutate('webhook-ids', { webhookIds: [webhookA, webhookA] }, 2)
    await mutate('webhook-ids', { webhookIds: [webhookA] }, 0)
    const afterClear = await api('config/snapshot')
    for (const id of [ids[4], ids[6], ids[7]]) {
      const destination = afterClear.destinations.find((d) => d.targetId === id)
      assert.equal(destination.webhook, null)
    }
    await mutate('destinations', { targetIds: ids }, 4)
    console.log(
      JSON.stringify({
        phase: 'api-cleanup',
        operations: 11,
        initialRevision,
        finalRevision: await assertOriginal(originalHash),
        originalDestinationsPreserved: true,
      }),
    )
    if (process.argv.includes('--prepare-java')) {
      const javaHash = await seed([
        row(ids[0], { guildId }),
        row(ids[1], { guildId }),
        row(ids[2]),
        row(ids[3], { channelId: ids[2], threadId: ids[3] }),
        row(ids[4], { webhook: hook(webhookA) }),
        row(ids[5], { webhook: hook(webhookB) }),
        row(ids[6], { channelId: ids[5], threadId: ids[6], webhook: hook(webhookB) }),
      ])
      await mkdir(new URL('../.wrangler/', import.meta.url), { recursive: true })
      await writeFile(
        fixturePath,
        JSON.stringify({ ids: ids.slice(0, 7), guildId, webhookA, webhookB, originalHash: javaHash }),
      )
      console.log(
        JSON.stringify({ phase: 'java-fixture-prepared', syntheticDestinations: 7, revision: await revision() }),
      )
    }
  }
} catch {
  // Never echo fetch/SQL/assertion values, which could include a snapshot or credentials.
  console.error(
    'Staging cleanup smoke failed; inspect only the reserved synthetic fixture state. Error details suppressed.',
  )
  process.exitCode = 1
}
