import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

const root = fileURLToPath(new URL('..',import.meta.url))
const core = path.resolve(process.env.EEWBOT_CORE_DIR ?? path.join(root,'..'))
const output = path.join(root,'.wrangler','java-quakeinfo-test')
await mkdir(output,{ recursive: true })
const jars = await Promise.all((await readdir(path.join(core,'build/libs'))).filter((f) => /^eewbot-.*\.jar$/.test(f))
  .map(async (name) => ({ name,modified: (await stat(path.join(core,'build/libs',name))).mtimeMs })))
jars.sort((a,b) => b.modified - a.modified)
const jar = process.env.EEWBOT_CORE_JAR ?? (jars[0] && path.join(core,'build/libs',jars[0].name))
if (!jar) throw new Error('Build PR B Java Core shadowJar first, or set EEWBOT_CORE_JAR.')
try { execFileSync('javac',['-encoding','UTF-8','-cp',jar,'-d',output,path.join(root,'test/java/QuakeInfoCoreProbe.java')],{ stdio: 'pipe' }) }
catch { throw new Error('QuakeInfo integration requires the Java Core publisher PR B build; see docs/quakeinfo-snapshot-api.md.') }
const bundle = path.join(output,'worker.mjs')
await build({ entryPoints: [path.join(root,'test/support/core-bridge.ts')],outfile: bundle,bundle: true,format: 'esm',platform: 'browser' })
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,scriptPath: bundle,host: '127.0.0.1',port: 0,
  compatibilityDate: '2026-10-24',d1Databases: ['DB'],bindings: { ACCESS_AUD: 'synthetic-core-aud' },
  outboundService: () => { throw new Error('Unexpected external request') },
}))
let java
try {
  const base = (await mf.ready).origin, db = await mf.getD1Database('DB')
  for (const name of (await readdir(path.join(root,'migrations'))).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = (await readFile(path.join(root,'migrations',name),'utf8')).replace(/--[^\n]*/g,'')
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) await db.prepare(statement).run()
  }
  java = spawn('java',['-Dfile.encoding=UTF-8','-Dstdout.encoding=UTF-8','-Dstderr.encoding=UTF-8','-cp',output + path.delimiter + jar,'net.teamfruit.eewbot.quakeinfo.QuakeInfoCoreProbe',base,
    path.join(core,'src/test/resources/jmaxml/vxse53/case1.xml')],{ stdio: ['pipe','pipe','pipe'] })
  const lines = []
  createInterface({ input: java.stdout }).on('line',(line) => { if (line === 'READY' || line.startsWith('RESULT ')) lines.push(line) })
  java.stderr.on('data',() => {})
  async function until(condition) {
    const deadline = Date.now() + 15_000
    while (!condition()) {
      if (java.exitCode !== null || Date.now() > deadline) throw new Error('QuakeInfo Java HTTP integration did not converge')
      await new Promise((r) => setTimeout(r,20))
    }
  }
  await until(() => lines.includes('READY'))
  async function command(action,variant) {
    const index = lines.length
    java.stdin.write(JSON.stringify({ action,variant }) + '\n')
    await until(() => lines.length > index)
    return JSON.parse(lines[index].slice(7))
  }
  const headers = { 'CF-Access-Client-Id': 'synthetic-core-id','CF-Access-Client-Secret': 'synthetic-core-secret' }
  async function latest(lang = 'ja_jp') {
    const response = await fetch(base + '/internal/v1/quakeinfo/latest?lang=' + lang,{ headers })
    assert.equal(response.status,200); return response.json()
  }
  const revisionBefore = await db.prepare('SELECT channels_revision FROM config_meta WHERE id = 1').first('channels_revision')
  const normal = await command('stage','normal')
  assert.equal((await latest()).snapshot,null,'Staging must never be visible')
  const rows = await db.prepare('SELECT lang,count(*) AS n FROM quake_snapshot_messages GROUP BY lang').all()
  assert.equal(rows.results.length,5)
  assert.ok(rows.results.every((row) => row.n > 1),'Actual Java EmbedPacker must produce multiple rows per language')
  assert.equal((await command('commit')).committed,true)
  for (const lang of ['ja_jp','en_us','zh_tw','ko_hanja','ko_kp']) {
    const read = await latest(lang)
    assert.equal(read.snapshot.snapshotId,normal.snapshotId)
    assert.deepEqual(read.messages.map((m) => m.embeds),normal.messages[lang].map((body) => JSON.parse(body)))
    assert.ok(normal.messages[lang].some((body) => body.includes('https://renderer.example.test')))
  }
  await command('stage','older')
  assert.equal((await command('commit')).status,409)
  assert.equal((await latest()).snapshot.snapshotId,normal.snapshotId)
  const correction = await command('stage','correction')
  assert.equal((await latest()).snapshot.snapshotId,normal.snapshotId)
  await command('commit')
  assert.equal((await latest()).snapshot.infoType,'訂正')
  const cancel = await command('stage','cancel'); await command('commit')
  assert.equal((await latest()).snapshot.isCancel,true)
  assert.equal((await latest()).snapshot.snapshotId,cancel.snapshotId)
  assert.ok((await command('start-publisher')).publisherEpoch > 1,'Actual async publisher must converge after restart')
  const beforeStop = await latest()
  await command('stop-publisher')
  assert.deepEqual(await latest(),beforeStop,'Worker must retain the last snapshot after the publisher stops')
  assert.equal(await db.prepare('SELECT channels_revision FROM config_meta WHERE id = 1').first('channels_revision'),revisionBefore)
  console.log('PASS: actual Java XML → 5-language packed embeds → HTTP staged D1 → atomic commit → correction/cancel → publisher restart/stop (configuration revision unchanged)')
} finally {
  if (java) {
    java.stdin.end()
    if (java.exitCode === null) await new Promise((r) => {
      const timer = setTimeout(() => { java.kill(); r() },2000)
      java.once('exit',() => { clearTimeout(timer); r() })
    })
  }
  await mf.dispose()
}
