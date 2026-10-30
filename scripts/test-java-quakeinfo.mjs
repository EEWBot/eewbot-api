import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare, Response as WorkerResponse } from 'miniflare'

const root = fileURLToPath(new URL('..', import.meta.url))
const core = path.resolve(process.env.EEWBOT_CORE_DIR ?? path.join(root, '..'))
const output = path.join(root, '.wrangler', 'java-quakeinfo-test')
await mkdir(output, { recursive: true })
const jars = await Promise.all(
  (await readdir(path.join(core, 'build/libs')))
    .filter((f) => /^eewbot-.*\.jar$/.test(f))
    .map(async (name) => ({ name, modified: (await stat(path.join(core, 'build/libs', name))).mtimeMs })),
)
jars.sort((a, b) => b.modified - a.modified)
const jar = process.env.EEWBOT_CORE_JAR ?? (jars[0] && path.join(core, 'build/libs', jars[0].name))
if (!jar) throw new Error('Build the Java Core shadowJar first, or set EEWBOT_CORE_JAR.')
try {
  execFileSync(
    'javac',
    ['-encoding', 'UTF-8', '-cp', jar, '-d', output, path.join(root, 'test/java/QuakeInfoCoreProbe.java')],
    { stdio: 'pipe' },
  )
} catch {
  throw new Error(
    'QuakeInfo integration requires a Java Core build with the single-PUT publisher; see docs/internal-api.md.',
  )
}
const bundle = path.join(output, 'worker.mjs')
await build({
  entryPoints: [path.join(root, 'test/support/core-bridge.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'browser',
})
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const APP = '1234567890123456780',
  GUILD = '1234567890123456781',
  CHANNEL = '1234567890123456782',
  THREAD = '1234567890123456783'
const replies = new Map()
let interactionSequence = 0
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: bundle,
    host: '127.0.0.1',
    port: 0,
    compatibilityDate: '2026-10-24',
    d1Databases: ['DB'],
    bindings: {
      ACCESS_AUD: 'synthetic-core-aud',
      DISCORD_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
      DISCORD_APPLICATION_ID: APP,
      DISCORD_COMMANDS_ENABLED: 'true',
    },
    outboundService: async (request) => {
      const url = new URL(request.url)
      assert.equal(url.origin, 'https://discord.com')
      assert.ok(['PATCH', 'POST'].includes(request.method))
      const token = url.pathname.replace('/api/v10', '').split('/')[3]
      const sent = replies.get(token) ?? []
      sent.push(await request.json())
      replies.set(token, sent)
      return WorkerResponse.json({ id: CHANNEL })
    },
  }),
)
let java
try {
  const base = (await mf.ready).origin,
    db = await mf.getD1Database('DB')
  for (const name of (await readdir(path.join(root, 'migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root, 'migrations', name), 'utf8')).replace(/--[^\n]*/g, '')
    for (const statement of sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run()
  }
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
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const lines = []
  createInterface({ input: java.stdout }).on('line', (line) => {
    if (line === 'READY' || line.startsWith('RESULT ')) lines.push(line)
  })
  java.stderr.on('data', () => {})
  async function until(condition, allowStopped = false, asyncCondition = undefined) {
    const deadline = Date.now() + 15_000
    while (!condition() && !(asyncCondition && (await asyncCondition()))) {
      if ((!allowStopped && java.exitCode !== null) || Date.now() > deadline)
        throw new Error('QuakeInfo Java HTTP integration did not converge')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  await until(() => lines.includes('READY'))
  async function command(action, options = {}) {
    const index = lines.length
    java.stdin.write(`${JSON.stringify({ action, ...options })}\n`)
    await until(() => lines.length > index)
    return JSON.parse(lines[index].slice(7))
  }
  const headers = { 'CF-Access-Client-Id': 'synthetic-core-id', 'CF-Access-Client-Secret': 'synthetic-core-secret' }
  async function latest(lang = 'ja_jp') {
    const response = await fetch(`${base}/internal/v2/quakeinfo/latest?lang=${lang}`, { headers })
    assert.equal(response.status, 200)
    return response.json()
  }
  async function invoke(channel, expectedMessages) {
    const token = `quakeinfo-test-${++interactionSequence}`
    const payload = {
      type: 2,
      id: String(1234567890123460000n + BigInt(interactionSequence)),
      application_id: APP,
      guild_id: GUILD,
      channel_id: channel,
      channel: channel === THREAD ? { type: 11, parent_id: CHANNEL } : { type: 0 },
      app_permissions: '0',
      token,
      member: { user: { id: CHANNEL }, permissions: '0' },
      data: { name: 'quakeinfo' },
    }
    const body = JSON.stringify(payload),
      timestamp = String(Math.floor(Date.now() / 1000))
    const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex')
    const response = await fetch(`${base}/interactions`, {
      method: 'POST',
      body,
      headers: {
        'X-Signature-Ed25519': signature,
        'X-Signature-Timestamp': timestamp,
      },
    })
    assert.equal(response.status, 200)
    const ack = await response.json()
    assert.equal(ack.type, 5)
    assert.equal(ack.data.flags, undefined)
    await until(() => replies.get(token)?.length === expectedMessages, true)
    const messages = replies.get(token)
    for (const message of messages) assert.deepEqual(message.allowed_mentions, { parse: [] })
    return messages
  }
  const revisionBefore = await db
    .prepare('SELECT channels_revision FROM config_meta WHERE id = 1')
    .first('channels_revision')
  const languages = ['ja_jp', 'en_us', 'zh_tw', 'ko_hanja', 'ko_kp']
  assert.match((await invoke(CHANNEL, 1))[0].content, /地震情報を取得できません/)

  const normal = await command('publish', { variant: 'normal' })
  assert.deepEqual([normal.accepted, normal.revision], [true, 1])
  for (const lang of languages) {
    const read = await latest(lang)
    const expected = normal.body.languages[lang]
    assert.ok(expected.length > 1, 'Actual Java EmbedPacker must produce several messages per language')
    assert.ok(JSON.stringify(expected).includes('https://renderer.example.test'))
    assert.deepEqual(
      read.messages.map((m) => m.embeds),
      expected,
    )
    await db
      .prepare(`INSERT INTO destinations (target_id,channel_id,guild_id,lang) VALUES (?,?,?,?)
      ON CONFLICT(target_id) DO UPDATE SET lang = excluded.lang`)
      .bind(CHANNEL, CHANNEL, GUILD, lang)
      .run()
    const delivered = await invoke(CHANNEL, expected.length)
    assert.deepEqual(
      delivered.map((message) => message.embeds),
      expected,
    )
  }
  await db
    .prepare('INSERT INTO destinations (target_id,channel_id,thread_id,guild_id,lang) VALUES (?,?,?,?,?)')
    .bind(THREAD, CHANNEL, THREAD, GUILD, 'en_us')
    .run()
  assert.deepEqual(
    (await invoke(THREAD, normal.body.languages.en_us.length)).map((message) => message.embeds),
    normal.body.languages.en_us,
  )

  const again = await command('publish', { variant: 'normal' })
  assert.deepEqual([again.accepted, again.revision], [true, 1], 'An identical re-publication must not churn')
  const older = await command('publish', { variant: 'older' })
  assert.deepEqual([older.accepted, older.revision], [false, 1])
  assert.equal((await latest()).snapshot.infoType, '発表')

  const correction = await command('publish', { variant: 'correction' })
  assert.deepEqual([correction.accepted, correction.revision], [true, 2])
  assert.equal((await latest()).snapshot.infoType, '訂正')
  assert.match((await invoke(THREAD, correction.body.languages.en_us.length))[0].content, /Correction/)
  const cancel = await command('publish', { variant: 'cancel' })
  assert.equal(cancel.accepted, true)
  assert.equal((await latest()).snapshot.infoType, '取消')
  assert.match((await invoke(THREAD, cancel.body.languages.en_us.length))[0].content, /Cancelled/)

  await command('start-publisher')
  await command('store', { variant: 'normal', reportDateTime: '2000-01-01T00:00:05Z' })
  await until(
    () => false,
    true,
    async () => (await latest()).snapshot.reportDateTime?.startsWith('2000-01-01T00:00:05'),
  )
  const beforeStop = await latest()
  assert.equal(beforeStop.snapshot.infoType, '発表')
  await command('stop-publisher')
  java.stdin.end()
  await until(() => java.exitCode !== null, true)
  assert.deepEqual(await latest(), beforeStop, 'Worker must retain the last report after the publisher stops')
  assert.equal(
    await db.prepare('SELECT channels_revision FROM config_meta WHERE id = 1').first('channels_revision'),
    revisionBefore,
  )
  console.log(
    'PASS: actual Java XML → 5-language packed embeds → PUT latest → signed /quakeinfo with ordered followups → identical/older/correction/cancel → async publisher → Java exit (configuration revision unchanged)',
  )
} finally {
  if (java) {
    java.stdin.end()
    if (java.exitCode === null)
      await new Promise((r) => {
        const timer = setTimeout(() => {
          java.kill()
          r()
        }, 2000)
        java.once('exit', () => {
          clearTimeout(timer)
          r()
        })
      })
  }
  await mf.dispose()
}
