import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare, Response as WorkerResponse } from 'miniflare'

// Optional cross-repository integration, independent of real credentials/services.
const root = fileURLToPath(new URL('..', import.meta.url))
const core = path.resolve(process.env.EEWBOT_CORE_DIR ?? path.join(root, '..'))
const output = path.join(root, '.wrangler', 'java-core-test')
await mkdir(output, { recursive: true })
const candidates = await Promise.all(
  (process.env.EEWBOT_CORE_JAR ? [] : await readdir(path.join(core, 'build/libs')))
    .filter((f) => /^eewbot-.*\.jar$/.test(f))
    .map(async (name) => ({ name, modified: (await stat(path.join(core, 'build/libs', name))).mtimeMs })),
)
candidates.sort((a, b) => b.modified - a.modified)
const jar = process.env.EEWBOT_CORE_JAR ?? (candidates[0] && path.join(core, 'build/libs', candidates[0].name))
if (!jar) throw new Error('Build the Java Core shadowJar first, or set EEWBOT_CORE_JAR.')
const packagePath = 'src/main/java/net/teamfruit/eewbot/registry/destination'
const sources = [
  'remote/RemoteConfigApiClient.java',
  'remote/RemoteDestinationConfigSource.java',
  'delivery/RevisionPoller.java',
  'delivery/SnapshotDeliveryRegistry.java',
  'delivery/DeliverySnapshot.java',
  'DestinationConfigSource.java',
]
execFileSync(
  'javac',
  [
    '-cp',
    jar,
    '-d',
    output,
    ...sources.map((s) => path.join(core, packagePath, s)),
    path.join(root, 'test/java/RemoteCoreProbe.java'),
  ],
  { stdio: 'pipe' },
)
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
  GUILD = '1234567890123456789',
  CHANNEL = '1234567890123456790',
  THREAD = '1234567890123456791'
const SECOND = '1234567890123456792',
  FOREIGN = '1234567890123456793',
  DM = '1234567890123456794'
const PERMS = (1024n | 2048n | (1n << 29n) | (1n << 38n)).toString()
const replies = new Map(),
  hooks = []
let sequence = 0
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: bundle,
    host: '127.0.0.1',
    port: 0,
    compatibilityDate: '2026-10-24',
    d1Databases: ['DB'],
    bindings: {
      DISCORD_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
      DISCORD_COMMANDS_ENABLED: 'true',
      DISCORD_APPLICATION_ID: APP,
      DISCORD_BOT_TOKEN: 'synthetic-bot-token',
      ACCESS_AUD: 'synthetic-core-aud',
    },
    outboundService: async (request) => {
      const url = new URL(request.url),
        p = url.pathname.replace('/api/v10', '')
      assert.equal(url.origin, 'https://discord.com')
      if (request.method === 'PATCH' && p.endsWith('/messages/@original')) {
        replies.set(p.split('/')[3], await request.json())
        return WorkerResponse.json({ id: CHANNEL })
      }
      if (p === '/oauth2/applications/@me') return WorkerResponse.json({ id: APP })
      if (p === `/guilds/${GUILD}/members/${APP}`) return WorkerResponse.json({ user: { id: APP }, roles: [] })
      if (p === `/guilds/${GUILD}/roles`) return WorkerResponse.json([{ id: GUILD, permissions: PERMS }])
      if (p === `/channels/${CHANNEL}`)
        return WorkerResponse.json({ id: CHANNEL, guild_id: GUILD, type: 0, permission_overwrites: [] })
      if (p === `/channels/${THREAD}`)
        return WorkerResponse.json({ id: THREAD, guild_id: GUILD, type: 11, parent_id: CHANNEL })
      if (p === `/channels/${SECOND}`) return WorkerResponse.json({ id: SECOND, guild_id: GUILD, type: 0 })
      if (p === `/channels/${CHANNEL}/webhooks`) {
        if (request.method === 'POST') {
          const hook = {
            id: String(1234567890123456800n + BigInt(hooks.length)),
            type: 1,
            token: 'synthetic-hook-token',
            user: { id: APP },
            guild_id: GUILD,
            channel_id: CHANNEL,
          }
          hooks.push(hook)
          return WorkerResponse.json(hook)
        }
        return WorkerResponse.json(hooks)
      }
      return new WorkerResponse(null, { status: 404 })
    },
  }),
)
let java
try {
  const base = (await mf.ready).origin
  const db = await mf.getD1Database('DB')
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
    ['-cp', output + path.delimiter + jar, 'net.teamfruit.eewbot.registry.destination.remote.RemoteCoreProbe', base],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const lines = [],
    waiters = []
  createInterface({ input: java.stdout }).on('line', (line) => {
    if (line === 'READY' || line.startsWith('OK ')) {
      console.log(line)
      lines.push(line)
      for (const waiter of waiters.splice(0)) waiter()
    }
  })
  java.stderr.on('data', () => {}) // Java errors can include inputs; never dump transport bodies.
  async function until(predicate) {
    const deadline = Date.now() + 10_000
    while (!predicate()) {
      if (java.exitCode !== null || Date.now() >= deadline) throw new Error('Java Core integration did not converge')
      await new Promise((r) => {
        const timer = setTimeout(r, 20)
        waiters.push(() => {
          clearTimeout(timer)
          r()
        })
      })
    }
  }
  await until(() => lines.includes('READY'))
  async function invoke(channelId, data, type = 2) {
    const token = `synthetic-interaction-${++sequence}`
    const payload = {
      id: String(1234567890123460000n + BigInt(sequence)),
      application_id: APP,
      guild_id: GUILD,
      channel_id: channelId,
      context: 0,
      authorizing_integration_owners: { 0: GUILD },
      app_permissions: PERMS,
      member: { permissions: '32', user: { id: CHANNEL } },
      token,
      type,
      data,
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
    assert.equal((await response.json()).type, type === 2 ? 5 : 6)
    await until(() => replies.has(token))
    const reply = replies.get(token)
    assert.equal(reply.allowed_mentions.parse.length, 0)
    return reply
  }
  let checkpoints = 0
  async function check(stage, expectedLanguages = {}) {
    const response = await fetch(`${base}/internal/v2/config/snapshot`, {
      headers: {
        'CF-Access-Client-Id': 'synthetic-core-id',
        'CF-Access-Client-Secret': 'synthetic-core-secret',
      },
    })
    assert.equal(response.status, 200)
    const snapshot = await response.json()
    for (const [id, lang] of Object.entries(expectedLanguages)) {
      assert.equal(snapshot.destinations.find((d) => d.targetId === id)?.lang, lang, 'Expected language must reach D1')
    }
    java.stdin.write(`${JSON.stringify({ stage, ...snapshot })}\n`)
    await until(() => lines.some((line) => line.startsWith(`OK ${stage} `)))
    checkpoints++
    return snapshot
  }
  async function select(reply, channel, index, values) {
    return invoke(channel, { custom_id: reply.components[index].components[0].custom_id, component_type: 3, values }, 3)
  }
  let channel = await invoke(CHANNEL, { name: 'setup' })
  assert.equal(channel.components.length, 3)
  await check('channel-register')
  channel = await select(channel, CHANNEL, 0, ['eewAlert', 'quakeInfo'])
  await check('channel-flags')
  channel = await select(channel, CHANNEL, 2, ['7'])
  await check('channel-intensity')
  let thread = await invoke(THREAD, { name: 'setup' })
  await check('thread-register')
  thread = await select(thread, THREAD, 0, ['tsunami'])
  thread = await select(thread, THREAD, 1, ['eewDecimation'])
  thread = await select(thread, THREAD, 2, ['9'])
  await check('thread-settings')
  assert.equal(hooks.length, 2)
  assert.notEqual(hooks[0].id, hooks[1].id)
  for (const id of [CHANNEL, THREAD]) {
    const confirm = await invoke(id, { name: 'unregister' })
    await invoke(id, { custom_id: confirm.components[0].components[0].custom_id, component_type: 2 }, 3)
    await check(id === CHANNEL ? 'parent-unregister-thread-retained' : 'thread-unregister-empty')
  }
  // Foreign guild and DM rows are isolated local fixtures: signed commands must
  // never be able to register or modify them through the signed Guild and destination boundary.
  await db.batch([
    db
      .prepare('INSERT INTO destinations (target_id, channel_id, guild_id, lang) VALUES (?, ?, ?, ?), (?, ?, NULL, ?)')
      .bind(FOREIGN, FOREIGN, FOREIGN, 'ko_hanja', DM, DM, 'zh_tw'),
    db.prepare('UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1 AND changes() > 0'),
  ])
  const outsiders = { [FOREIGN]: 'ko_hanja', [DM]: 'zh_tw' }
  channel = await invoke(CHANNEL, { name: 'lang' })
  assert.equal(channel.components.length, 2)
  await check('lang-channel-register', { ...outsiders, [CHANNEL]: 'ja_jp' })
  for (const code of ['ja_jp', 'en_us', 'zh_tw', 'ko_hanja', 'ko_kp']) {
    channel = await select(channel, CHANNEL, 0, [code])
    await check(`lang-select-${code.replaceAll('_', '-')}`, { ...outsiders, [CHANNEL]: code })
  }
  await invoke(SECOND, { name: 'lang' })
  await check('lang-second-channel', { ...outsiders, [CHANNEL]: 'ko_kp', [SECOND]: 'ja_jp' })
  thread = await invoke(THREAD, { name: 'lang' })
  await check('lang-thread-register', { ...outsiders, [CHANNEL]: 'ko_kp', [THREAD]: 'ja_jp' })
  thread = await select(thread, THREAD, 0, ['zh_tw'])
  await check('lang-independent-thread', { ...outsiders, [CHANNEL]: 'ko_kp', [SECOND]: 'ja_jp', [THREAD]: 'zh_tw' })
  channel = await invoke(CHANNEL, { name: 'lang' })
  channel = await select(channel, CHANNEL, 0, ['en_us'])
  const before = await check('lang-source-english', { ...outsiders, [CHANNEL]: 'en_us' })
  const applied = await invoke(
    CHANNEL,
    { custom_id: channel.components[1].components[0].custom_id, component_type: 2 },
    3,
  )
  assert.match(applied.content, /Updated destinations: 3/)
  const after = await check('lang-guild-apply', {
    ...outsiders,
    [CHANNEL]: 'en_us',
    [SECOND]: 'en_us',
    [THREAD]: 'en_us',
  })
  assert.equal(after.revision, before.revision + 1)
  const omitLanguage = (d) => {
    const { lang, ...fields } = d
    return fields
  }
  assert.deepEqual(after.destinations.map(omitLanguage), before.destinations.map(omitLanguage))
  assert.equal(hooks.length, 2, '/lang must never create webhooks')
  for (const id of [CHANNEL, SECOND, THREAD]) {
    const confirm = await invoke(id, { name: 'unregister' })
    await invoke(id, { custom_id: confirm.components[0].components[0].custom_id, component_type: 2 }, 3)
  }
  const remaining = await check('lang-cleanup-outsiders-preserved', outsiders)
  assert.equal(remaining.destinations.length, 2)
  console.log(
    `PASS: signed interactions → local D1 → HTTP snapshot → Java config source / RevisionPoller / I18n (${checkpoints} checkpoints)`,
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
