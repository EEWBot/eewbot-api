import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

// Legacy Java SQLite store → Core's real import CLI → local Worker D1 → snapshot.
const root = fileURLToPath(new URL('..', import.meta.url))
const core = path.resolve(process.env.EEWBOT_CORE_DIR ?? path.join(root, '..'))
const output = path.join(root, '.wrangler', 'java-import-test')
await mkdir(output, { recursive: true })
const jars = await Promise.all(
  (process.env.EEWBOT_CORE_JAR ? [] : await readdir(path.join(core, 'build/libs')))
    .filter((f) => /^eewbot-.*\.jar$/.test(f))
    .map(async (name) => ({ name, modified: (await stat(path.join(core, 'build/libs', name))).mtimeMs })),
)
jars.sort((a, b) => b.modified - a.modified)
const jar = process.env.EEWBOT_CORE_JAR ?? (jars[0] && path.join(core, 'build/libs', jars[0].name))
if (!jar) throw new Error('Build the Java Core shadowJar first, or set EEWBOT_CORE_JAR.')
const packagePath = 'src/main/java/net/teamfruit/eewbot/registry/destination/remote'
execFileSync(
  'javac',
  [
    '-encoding',
    'UTF-8',
    '-cp',
    jar,
    '-d',
    output,
    ...[
      'RemoteDestinationImport.java',
      'RemoteMigrationApiClient.java',
      'RemoteConfigApiClient.java',
      'RemoteDestinationConfigSource.java',
    ].map((s) => path.join(core, packagePath, s)),
    path.join(root, 'test/java/RemoteImportProbe.java'),
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

const GUILD = '1234567890123456789',
  CHANNEL = '1234567890123456790',
  THREAD = '1234567890123456791',
  DM = '1234567890123456792',
  APP_CHANNEL = '1234567890123456793',
  BROKEN = '1234567890123456794',
  BAD_LANG = '1234567890123456795',
  BAD_IDENTITY = '1234567890123456796',
  WORKER_ONLY = '1234567890123456797',
  HOOK = '1234567890123456800',
  APP_HOOK = '1234567890123456801'
const TOKEN = 'synthetic-legacy-token-0123456789',
  APP_TOKEN = 'synthetic-discordapp-token-0123456789'

// The legacy schema is Core's V1 + V2 SQLite migrations.
const legacyPath = path.join(output, 'channels.db')
await rm(legacyPath, { force: true })
const legacy = new DatabaseSync(legacyPath)
legacy.exec(`CREATE TABLE destinations (
  target_id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, thread_id INTEGER, guild_id INTEGER,
  eew_alert INTEGER NOT NULL DEFAULT 0, eew_prediction INTEGER NOT NULL DEFAULT 0,
  eew_decimation INTEGER NOT NULL DEFAULT 0, quake_info INTEGER NOT NULL DEFAULT 0,
  min_intensity INTEGER NOT NULL DEFAULT 1, lang TEXT NOT NULL DEFAULT 'ja_jp',
  webhook_url TEXT, webhook_id INTEGER, tsunami INTEGER NOT NULL DEFAULT 0)`)
const insert = legacy.prepare(`INSERT INTO destinations (target_id, channel_id, thread_id, guild_id, eew_alert,
  eew_prediction, eew_decimation, quake_info, tsunami, min_intensity, lang, webhook_url, webhook_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
const id = (value) => (value === null ? null : BigInt(value))
for (const [target, channel, thread, guild, flags, intensity, lang, url, hook] of [
  [
    CHANNEL,
    CHANNEL,
    null,
    GUILD,
    [1, 0, 1, 1, 1],
    7,
    'ja_jp',
    `https://discord.com/api/webhooks/${HOOK}/${TOKEN}`,
    HOOK,
  ],
  [
    THREAD,
    CHANNEL,
    THREAD,
    GUILD,
    [0, 1, 0, 0, 0],
    0,
    'en_US',
    `https://discord.com/api/webhooks/${HOOK}/${TOKEN}?thread_id=${THREAD}`,
    HOOK,
  ],
  [DM, DM, null, null, [1, 1, 1, 1, 1], 9, 'zh_tw', null, null],
  [
    APP_CHANNEL,
    APP_CHANNEL,
    null,
    GUILD,
    [1, 0, 0, 0, 0],
    3,
    'ko_hanja',
    `https://discordapp.com/api/webhooks/${APP_HOOK}/${APP_TOKEN}`,
    APP_HOOK,
  ],
  [BROKEN, BROKEN, null, GUILD, [0, 0, 0, 1, 0], 5, 'ko_kp', 'https://example.com/not-a-webhook', null],
  [BAD_LANG, BAD_LANG, null, GUILD, [1, 0, 0, 0, 0], 1, 'fr_fr', null, null],
  [BAD_IDENTITY, BAD_IDENTITY, BAD_IDENTITY, GUILD, [1, 0, 0, 0, 0], 1, 'ja_jp', null, null],
]) {
  insert.run(id(target), id(channel), id(thread), id(guild), ...flags, intensity, lang, url, id(hook))
}
legacy.close()

const destination = (targetId, fields) => ({
  targetId,
  channelId: targetId,
  threadId: null,
  guildId: GUILD,
  eewAlert: false,
  eewPrediction: false,
  eewDecimation: false,
  quakeInfo: false,
  tsunami: false,
  minIntensity: 1,
  lang: 'ja_jp',
  webhook: null,
  ...fields,
})
const imported = [
  destination(CHANNEL, {
    eewAlert: true,
    eewDecimation: true,
    quakeInfo: true,
    tsunami: true,
    minIntensity: 7,
    webhook: { id: HOOK, token: TOKEN },
  }),
  destination(THREAD, {
    channelId: CHANNEL,
    threadId: THREAD,
    eewPrediction: true,
    minIntensity: 0,
    lang: 'en_us',
    webhook: { id: HOOK, token: TOKEN },
  }),
  destination(DM, {
    guildId: null,
    eewAlert: true,
    eewPrediction: true,
    eewDecimation: true,
    quakeInfo: true,
    tsunami: true,
    minIntensity: 9,
    lang: 'zh_tw',
  }),
  destination(APP_CHANNEL, {
    eewAlert: true,
    minIntensity: 3,
    lang: 'ko_hanja',
    webhook: { id: APP_HOOK, token: APP_TOKEN },
  }),
  destination(BROKEN, { quakeInfo: true, minIntensity: 5, lang: 'ko_kp' }),
]

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: bundle,
    host: '127.0.0.1',
    port: 0,
    compatibilityDate: '2026-10-24',
    d1Databases: ['DB'],
    bindings: { ACCESS_AUD: 'synthetic-core-aud' },
  }),
)
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
  // A row registered through Discord before the import is overwritten; a Worker-only row is kept.
  await db.batch([
    db
      .prepare('INSERT INTO destinations (target_id, channel_id, guild_id, lang) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
      .bind(CHANNEL, CHANNEL, GUILD, 'ko_kp', WORKER_ONLY, WORKER_ONLY, GUILD, 'ja_jp'),
    db.prepare('UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1 AND changes() > 0'),
  ])
  const snapshot = async () => {
    const response = await fetch(`${base}/internal/v2/config/snapshot`, {
      headers: { 'CF-Access-Client-Id': 'synthetic-core-id', 'CF-Access-Client-Secret': 'synthetic-core-secret' },
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const runImport = (...args) => {
    const java = spawnSync(
      'java',
      [
        '-cp',
        output + path.delimiter + jar,
        'net.teamfruit.eewbot.registry.destination.remote.RemoteImportProbe',
        '--source',
        'sqlite',
        '--source-path',
        legacyPath,
        '--base-url',
        base,
        '--chunk-size',
        '2',
        ...args,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    )
    // Only the summary lines are echoed: Java errors can include request data.
    const out = `${java.stdout}\n${java.stderr}`
    const exit = /^EXIT (\d+)$/m.exec(out)
    assert.ok(exit, 'Import probe did not finish')
    const summary = /Import sent (\d+) destinations, affected (\d+), skipped (\d+), webhook dropped (\d+)/.exec(out)
    if (summary) console.log(summary[0])
    return { exit: Number(exit[1]), summary: summary?.slice(1).map(Number), out }
  }

  const initial = await snapshot()
  let result = runImport('--dry-run')
  assert.equal(result.exit, 0)
  assert.deepEqual(await snapshot(), initial, '--dry-run must not write')

  result = runImport()
  assert.equal(result.exit, 0, 'Import (with verification) must succeed')
  assert.deepEqual(result.summary, [5, 5, 2, 1])
  const after = await snapshot()
  assert.equal(after.revision, initial.revision + 3, 'One revision per changed chunk')
  const byTarget = (list) => [...list].sort((a, b) => a.targetId.localeCompare(b.targetId))
  assert.deepEqual(
    byTarget(after.destinations),
    byTarget([...imported, destination(WORKER_ONLY, {})]),
    'D1 must hold every convertible legacy row and keep Worker-only rows',
  )

  result = runImport()
  assert.equal(result.exit, 0)
  assert.deepEqual(result.summary, [5, 0, 2, 1], 'Re-running the import must be a no-op')
  assert.equal((await snapshot()).revision, after.revision)
  console.log('PASS: legacy SQLite → Java import CLI → local D1 → Java snapshot verification')
} finally {
  await mf.dispose()
}
