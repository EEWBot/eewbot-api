import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

// Explicit opt-in, fixed staging host/database/application only. Never invoke in normal CI.
const root = fileURLToPath(new URL('..', import.meta.url))
const config = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'))
assert.equal(config.env.staging.d1_databases[0].database_id, '30988518-b77a-4f66-806e-52f266a2aeda')
assert.equal(config.env.staging.vars.DISCORD_APPLICATION_ID, '350178549782544384')
const base = 'https://api-staging.eewbot.net'
const normalOnly = process.argv.includes('--normal-only')
// Compatibility for the user's preexisting local dotenv names; no new credentials are issued or persisted.
process.env.EEWBOT_CF_ACCESS_CLIENT_ID ??= process.env.API_CLIENT_ID
process.env.EEWBOT_CF_ACCESS_CLIENT_SECRET ??= process.env.API_CLIENT_SECRET
const id = process.env.EEWBOT_CF_ACCESS_CLIENT_ID,
  secret = process.env.EEWBOT_CF_ACCESS_CLIENT_SECRET
if (!id || !secret) throw new Error('Load the existing shared Access credentials into the environment.')
const headers = { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, 'Content-Type': 'application/json' }
async function get(path) {
  const response = await fetch(base + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  return response.json()
}
const initial = await get('/internal/v2/quakeinfo/latest/meta')
if (initial.snapshot && initial.snapshot.eventId !== 'TEST-quakeinfo-fixture')
  throw new Error('Staging has non-test earthquake data; refusing to replace it.')
const reportTime = initial.snapshot
  ? new Date(Date.parse(initial.snapshot.reportDateTime) + 60000).toISOString()
  : '2000-01-01T00:00:00Z'
assert.ok(Date.parse(reportTime) < Date.parse('2001-01-01T00:00:00Z'))
const revisionBefore = await get('/internal/v2/config/revision')
const core = path.resolve(process.env.EEWBOT_CORE_DIR ?? path.join(root, '..'))
const output = path.join(root, '.wrangler', 'quakeinfo-staging')
await mkdir(output, { recursive: true })
const jars = (await readdir(path.join(core, 'build/libs'))).filter((f) => /^eewbot-.*\.jar$/.test(f))
assert.equal(jars.length, 1)
const jar = path.join(core, 'build/libs', jars[0])
execFileSync(
  'javac',
  ['-encoding', 'UTF-8', '-cp', jar, '-d', output, path.join(root, 'test/java/QuakeInfoCoreProbe.java')],
  { stdio: 'pipe' },
)
let java
const summary = {
  checkedAt: new Date().toISOString(),
  worker: 'eewbot-api-staging',
  databaseId: config.env.staging.d1_databases[0].database_id,
  productionChanged: false,
  initialSnapshotId: initial.snapshot?.snapshotId ?? null,
  steps: [],
}
try {
  const unauth = await fetch(`${base}/internal/v2/quakeinfo/publisher/lease`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  })
  assert.ok([401, 403].includes(unauth.status))
  summary.steps.push({ check: 'unauthenticated POST rejected', status: unauth.status })
  java = spawn(
    'java',
    [
      '-Dfile.encoding=UTF-8',
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      '-cp',
      output + path.delimiter + jar,
      'net.teamfruit.eewbot.quakeinfo.QuakeInfoCoreProbe',
      base,
      path.join(core, 'src/test/resources/jmaxml/vxse53/case1.xml'),
      '--staging',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
  )
  const lines = []
  createInterface({ input: java.stdout }).on('line', (line) => {
    if (line === 'READY' || line.startsWith('RESULT ')) lines.push(line)
  })
  java.stderr.on('data', () => {})
  async function until(condition) {
    const deadline = Date.now() + 60000
    while (!condition()) {
      if (java.exitCode !== null || Date.now() > deadline) throw new Error('Staging Java verification did not converge')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  await until(() => lines.includes('READY'))
  async function command(action, variant) {
    const index = lines.length
    java.stdin.write(`${JSON.stringify({ action, variant, reportDateTime: reportTime })}\n`)
    await until(() => lines.length > index)
    return JSON.parse(lines[index].slice(7))
  }
  let priorId = initial.snapshot?.snapshotId ?? null
  for (const variant of normalOnly ? ['normal'] : ['normal', 'older', 'correction', 'cancel']) {
    const staged = await command('stage', variant)
    assert.equal((await get('/internal/v2/quakeinfo/latest/meta')).snapshot?.snapshotId ?? null, priorId)
    const commit = await command('commit')
    if (variant === 'older') {
      assert.equal(commit.status, 409)
      summary.steps.push({ check: 'older report rejected', status: commit.status })
      continue
    }
    assert.equal(commit.committed, true)
    const counts = {}
    for (const lang of ['ja_jp', 'en_us', 'zh_tw', 'ko_hanja', 'ko_kp']) {
      const latest = await get(`/internal/v2/quakeinfo/latest?lang=${lang}`)
      assert.equal(latest.snapshot.snapshotId, staged.snapshotId)
      assert.deepEqual(
        latest.messages.map((message) => message.embeds),
        staged.messages[lang].map(JSON.parse),
      )
      counts[lang] = latest.messages.length
    }
    if (variant !== 'cancel') assert.ok(Object.values(counts).every((n) => n > 1))
    summary.steps.push({ check: variant, snapshotId: staged.snapshotId, messageCounts: counts })
    priorId = staged.snapshotId
  }
  const restarted = normalOnly ? null : await command('start-publisher')
  if (restarted) assert.ok(restarted.publisherEpoch > 1)
  await command('stop-publisher')
  const saved = await get('/internal/v2/quakeinfo/latest/meta')
  assert.equal(saved.snapshot.isCancel, !normalOnly)
  const cleanup = await fetch(`${base}/internal/v2/quakeinfo/cleanup`, {
    method: 'POST',
    headers,
    body: '{}',
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  })
  assert.equal(cleanup.status, 200)
  assert.equal((await get('/internal/v2/quakeinfo/latest/meta')).snapshot.snapshotId, saved.snapshot.snapshotId)
  assert.deepEqual(await get('/internal/v2/config/revision'), revisionBefore)
  assert.equal((await get('/internal/v2/cleanup/meta')).apiVersion, 2)
  assert.equal((await get('/internal/v2/meta')).apiVersion, 2)
  summary.steps.push({
    check: 'publisher stop, cleanup, existing Internal/Cleanup and configuration revision',
    publisherEpoch: saved.snapshot.publisherEpoch,
    channelsRevision: revisionBefore.revision,
  })
  summary.finalSnapshotId = saved.snapshot.snapshotId
  summary.finalQuakeRevision = saved.revision
  summary.finalState = `Marked historical TEST ${normalOnly ? '3-message report for manual Discord verification' : 'cancellation'} retained; publisher stopped; no ordinary destination was notified.`
  await writeFile(
    path.join(output, normalOnly ? 'manual-fixture.json' : 'result.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  )
  console.log(JSON.stringify(summary, null, 2))
} finally {
  if (java) {
    java.stdin.end()
    if (java.exitCode === null)
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          java.kill()
          resolve()
        }, 5000)
        java.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
  }
}
