import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import app from '../src/index'
import { LANGUAGES } from '../src/i18n/languages'
import { QuakeStore, RETIRED_RETENTION_MS, STAGING_RETENTION_MS } from '../src/quakeinfo/store'
import { encoder, MAX_MESSAGE_BYTES, sha256, type SnapshotInput } from '../src/quakeinfo/validation'

const AUD = 'synthetic-common-aud'
const store = new QuakeStore(env.DB)
beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('UPDATE quake_latest SET snapshot_id = NULL, quake_revision = 0'),
    env.DB.prepare('DELETE FROM quake_snapshots'), env.DB.prepare('DELETE FROM quake_publisher_leases'),
    env.DB.prepare('UPDATE quake_publisher_state SET publisher_epoch = 0'),
  ])
})
async function request(path: string, body?: unknown, options: { method?: string; raw?: string; aud?: string | null; contentType?: string; noDb?: boolean } = {}) {
  const ctx = createExecutionContext()
  Object.defineProperty(ctx, 'access', { value: options.aud === null ? undefined : { aud: options.aud ?? AUD } })
  const response = await app.fetch(new Request('https://example.com/internal/v1/quakeinfo' + path, {
    method: options.method ?? (body === undefined && options.raw === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': options.contentType ?? 'application/json', 'CF-Access-Client-Id': 'forged', 'CF-Access-Client-Secret': 'secret-must-not-leak' },
    body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), options.noDb ? { ACCESS_AUD: AUD, get DB() { throw new Error('secret-must-not-leak SQL') } } : { DB: env.DB, ACCESS_AUD: AUD }, ctx)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return response
}
async function candidate(overrides: Partial<SnapshotInput> = {}, counts = [3,2,1,2,1]) {
  const bodies = Object.fromEntries(LANGUAGES.map(({ code }, l) => [code,
    Array.from({ length: counts[l] }, (_, i) => JSON.stringify([{ title: `TEST ${code} ${i}`, description: 'Synthetic earthquake fixture', timestamp: '2026-01-01T00:00:00Z' }]))]))
  const languages = {} as SnapshotInput['languages']
  let manifest = ''
  for (const { code } of LANGUAGES) {
    languages[code] = await Promise.all(bodies[code].map(async (body, index) => {
      const contentHash = await sha256(body), byteLength = encoder.encode(body).byteLength
      manifest += `${code}:${index}:${contentHash}:${byteLength}\n`
      return { contentHash, byteLength }
    }))
  }
  // Promise callbacks append after independent digest operations; explicitly restore deterministic order.
  manifest = LANGUAGES.flatMap(({ code }) => languages[code].map((e, i) => `${code}:${i}:${e.contentHash}:${e.byteLength}\n`)).join('')
  const input: SnapshotInput = { snapshotId: crypto.randomUUID(), schemaVersion: 1, eventId: '20260101000000', reportType: 'VXSE53',
    reportDateTime: '2026-01-01T00:00:00Z', dateTime: '2026-01-01T00:00:00Z', serial: 1, infoType: '発表',
    infoTypePriority: 0, isCancel: false, renderedAt: '2026-01-01T00:00:01Z',
    contentHash: await sha256(manifest), publisherEpoch: 1, publisherSequence: 1, languages, ...overrides }
  return { input, bodies }
}
async function lease() {
  const id = crypto.randomUUID()
  const response = await request('/publisher/lease', { publisherId: id })
  expect(response.status).toBe(200)
  return { id, ...await response.json() as { publisherEpoch: number } }
}
async function stage(c: Awaited<ReturnType<typeof candidate>>, skip?: string) {
  expect((await request('/snapshots', c.input)).status).toBe(200)
  for (const { code } of LANGUAGES) for (const [i, raw] of c.bodies[code].entries()) {
    if (`${code}:${i}` === skip) continue
    expect((await request(`/snapshots/${c.input.snapshotId}/messages/${code}/${i}`, undefined, { method: 'PUT', raw })).status).toBe(200)
  }
}
async function commit(id: string) { return request(`/snapshots/${id}/commit`, {}) }
async function published() { return (await request('/latest/meta')).json() as Promise<{ revision: number; snapshot: { snapshotId: string } | null }> }

describe('atomic multilingual snapshots', () => {
  it('stores five languages and variable message counts in separate ordered rows; publishes only after commit', async () => {
    await lease()
    const c = await candidate()
    await stage(c)
    expect((await published()).snapshot).toBeNull()
    const rows = await env.DB.prepare('SELECT lang,count(*) AS n FROM quake_snapshot_messages GROUP BY lang').all()
    expect(rows.results).toHaveLength(5)
    expect(rows.results.find((r) => r.lang === 'ja_jp')?.n).toBe(3)
    expect((await commit(c.input.snapshotId)).status).toBe(200)
    const result = await (await request('/latest?lang=ja_jp')).json() as any
    expect(result.messages.map((m: any) => m.messageIndex)).toEqual([0,1,2])
    expect(result.messages.map((m: any) => m.embeds)).toEqual(c.bodies.ja_jp.map(JSON.parse as any))
    expect(result.snapshot).toMatchObject({ eventId: c.input.eventId, committedAt: expect.any(Number) })
    expect(result.revision).toBe(1)
  })
  it('rejects missing languages/message gaps and leaves the prior publication intact', async () => {
    await lease()
    const first = await candidate(); await stage(first); await commit(first.input.snapshotId)
    const next = await candidate({ publisherSequence: 2, serial: 2 }); await stage(next, 'en_us:1')
    expect((await commit(next.input.snapshotId)).status).toBe(409)
    expect((await published()).snapshot?.snapshotId).toBe(first.input.snapshotId)
  })
  it('supports idempotent create, exact message retries, and historical recommits without advancing revision', async () => {
    await lease(); const c = await candidate(); await stage(c); await stage(c)
    expect((await request('/snapshots',Object.fromEntries(Object.entries(c.input).reverse()))).status).toBe(200)
    expect((await commit(c.input.snapshotId)).status).toBe(200)
    expect((await commit(c.input.snapshotId)).status).toBe(200)
    await stage(c)
    expect((await published()).revision).toBe(1)
    const next = await candidate({ publisherSequence: 2, serial: 2 }); await stage(next); await commit(next.input.snapshotId)
    expect((await commit(c.input.snapshotId)).status).toBe(200)
    expect((await published()).snapshot?.snapshotId).toBe(next.input.snapshotId)
    expect((await published()).revision).toBe(2)
  })
  it('rejects conflicting IDs, sequence reuse, duplicate-message overwrites, wrong hash and undeclared indices', async () => {
    await lease(); const c = await candidate(); await stage(c)
    expect((await request('/snapshots', { ...c.input, eventId: 'other' })).status).toBe(409)
    expect((await request('/snapshots', { ...c.input, snapshotId: crypto.randomUUID() })).status).toBe(409)
    for (const [index, raw] of [[0,'[{"title":"DIFFERENT"}]'],[3,c.bodies.ja_jp[0]]] as const) {
      expect((await request(`/snapshots/${c.input.snapshotId}/messages/ja_jp/${index}`, undefined, { method: 'PUT', raw })).status).toBe(409)
    }
  })
  it('does not expose a half written snapshot after failed storage', async () => {
    await lease(); const c = await candidate(); await request('/snapshots',c.input)
    const failed = await request(`/snapshots/${c.input.snapshotId}/messages/ja_jp/0`, undefined,
      { method: 'PUT', raw: c.bodies.ja_jp[0], noDb: true })
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('secret')
    expect((await commit(c.input.snapshotId)).status).toBe(409)
    expect((await published()).snapshot).toBeNull()
  })
  it('uses a transaction that rolls back pointer and retirement if commit metadata fails', async () => {
    await lease(); const first = await candidate(); await stage(first); await commit(first.input.snapshotId)
    const next = await candidate({ serial: 2, publisherSequence: 2 }); await stage(next)
    await env.DB.exec("CREATE TRIGGER fail_quake_commit BEFORE UPDATE OF status ON quake_snapshots BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;")
    try {
      expect((await commit(next.input.snapshotId)).status).toBe(503)
      expect((await published()).snapshot?.snapshotId).toBe(first.input.snapshotId)
      expect(await env.DB.prepare('SELECT retired_at FROM quake_snapshots WHERE snapshot_id = ?').bind(first.input.snapshotId).first('retired_at')).toBeNull()
    } finally { await env.DB.exec('DROP TRIGGER fail_quake_commit') }
  })
})

describe('ordering and publisher fencing', () => {
  it.each([
    { reportDateTime: '2025-12-31T23:59:59Z', serial: 99 },
    { dateTime: '2025-12-31T23:59:59Z', serial: 99 },
    { serial: -1 }, { reportDateTime: null },
  ])('rejects older source ordering %j', async (overrides) => {
    await lease(); const first = await candidate(); await stage(first); await commit(first.input.snapshotId)
    const old = await candidate({ ...overrides, publisherSequence: 2 }); await stage(old)
    expect((await commit(old.input.snapshotId)).status).toBe(409)
    expect((await published()).snapshot?.snapshotId).toBe(first.input.snapshotId)
  })
  it('compares nanoseconds without millisecond precision loss', async () => {
    await lease(); const first = await candidate({ reportDateTime: '2026-01-01T00:00:00.000000002Z' }); await stage(first); await commit(first.input.snapshotId)
    const old = await candidate({ reportDateTime: '2026-01-01T00:00:00.000000001Z', publisherSequence: 2 }); await stage(old)
    expect((await commit(old.input.snapshotId)).status).toBe(409)
  })
  it('orders corrections then cancellations above ordinary reports, independent of arrival sequence', async () => {
    await lease()
    const normal = await candidate(), correction = await candidate({ infoType: '訂正', infoTypePriority: 1, publisherSequence: 2 }),
      cancel = await candidate({ infoType: '取消', infoTypePriority: 2, isCancel: true, publisherSequence: 3 })
    for (const c of [normal,correction,cancel]) { await stage(c); expect((await commit(c.input.snapshotId)).status).toBe(200) }
    const late = await candidate({ publisherSequence: 4 }); await stage(late)
    expect((await commit(late.input.snapshotId)).status).toBe(409)
    expect((await published()).snapshot?.snapshotId).toBe(cancel.input.snapshotId)
  })
  it('permits same-source rerender, rejects reversed sequences and a different source tied on ordering', async () => {
    await lease()
    const first = await candidate({ publisherSequence: 2 }); await stage(first); await commit(first.input.snapshotId)
    const rerender = await candidate({ publisherSequence: 3 }); await stage(rerender); expect((await commit(rerender.input.snapshotId)).status).toBe(200)
    const delayed = await candidate({ publisherSequence: 1 }); await stage(delayed); expect((await commit(delayed.input.snapshotId)).status).toBe(409)
    const different = await candidate({ publisherSequence: 4, eventId: 'other' }); await stage(different); expect((await commit(different.input.snapshotId)).status).toBe(409)
  })
  it('issues idempotent monotonically increasing boot leases; fences old process and rejects stale feed after restart', async () => {
    const boot = await lease()
    expect(await (await request('/publisher/lease',{ publisherId: boot.id })).json()).toEqual({ publisherEpoch: 1 })
    const pending = await candidate(); await stage(pending)
    expect((await lease()).publisherEpoch).toBe(2)
    expect((await commit(pending.input.snapshotId)).status).toBe(409)
    const current = await candidate({ publisherEpoch: 2 }); await stage(current); await commit(current.input.snapshotId)
    const oldProcess = await candidate({ publisherSequence: 2, serial: 999 })
    expect((await request('/snapshots',oldProcess.input)).status).toBe(409)
    await lease()
    const oldFeed = await candidate({ publisherEpoch: 3, serial: -1 }); await stage(oldFeed)
    expect((await commit(oldFeed.input.snapshotId)).status).toBe(409)
    const refreshed = await candidate({ publisherEpoch: 3, publisherSequence: 2 }); await stage(refreshed)
    expect((await commit(refreshed.input.snapshotId)).status).toBe(200)
  })
  it('serializes concurrent commits so the final pointer is always the newest source', async () => {
    await lease()
    const low = await candidate(), high = await candidate({ serial: 2, publisherSequence: 2 })
    await stage(low); await stage(high)
    const results = await Promise.all([commit(high.input.snapshotId),commit(low.input.snapshotId)])
    expect(results.every((r) => [200,409].includes(r.status))).toBe(true)
    expect((await published()).snapshot?.snapshotId).toBe(high.input.snapshotId)
  })
})

describe('strict validation and common Access boundary', () => {
  it.each([null,'wrong-aud'])('rejects unauthenticated reads and writes before D1 access (%s)', async (aud) => {
    for (const [path, body] of [['/publisher/lease',{}],['/snapshots',{}],['/latest',undefined],['/latest/meta',undefined]] as const) {
      expect((await request(path,body,{ aud,noDb: true })).status).toBe(403)
    }
  })
  it('rejects wrong content type, oversized streamed bodies, unknown fields and SQL-shaped IDs', async () => {
    expect((await request('/publisher/lease',{}, { contentType: 'text/plain' })).status).toBe(415)
    expect((await request('/publisher/lease',undefined, { raw: 'x'.repeat(1025) })).status).toBe(413)
    expect((await request('/publisher/lease',{ publisherId: "';DROP TABLE destinations;--" })).status).toBe(400)
    expect((await request('/publisher/lease',{ publisherId: crypto.randomUUID(), url: 'https://example.com' })).status).toBe(400)
  })
  it.each(['fr_fr','JA_JP',"'; DROP TABLE quake_latest;--"])('rejects language %s', async (lang) => {
    expect((await request('/latest?lang=' + encodeURIComponent(lang))).status).toBe(400)
  })
  it.each([[],[{} ,{}, {},{}, {},{}, {},{}, {},{},{}], [{ title: 'a'.repeat(257) }], [{ fields: Array(26).fill({ name: '', value: '' }) }],
    [{ description: 'a'.repeat(4000) },{ description: 'b'.repeat(3000) }], [{ image: { url: 'file:///secret' } }], [{ footer: { text: 'x', secret: 'x' } }], [{ color: -1 }]].map((embeds) => ({ embeds })))
    ('rejects invalid Discord embeds %j', async ({ embeds }) => {
      const id = crypto.randomUUID()
      expect((await request(`/snapshots/${id}/messages/ja_jp/0`,undefined,{ method: 'PUT',raw: JSON.stringify(embeds) })).status).toBe(400)
    })
  it('measures UTF-8 bytes, not JS character length, at the row boundary', async () => {
    const raw = '[{"description":"' + '震'.repeat(MAX_MESSAGE_BYTES / 3) + '"}]'
    expect(raw.length).toBeLessThan(MAX_MESSAGE_BYTES)
    expect((await request(`/snapshots/${crypto.randomUUID()}/messages/ja_jp/0`,undefined,{ method: 'PUT', raw })).status).toBe(413)
  })
  it('rejects missing language manifests, invalid byte counts, unknown fields and malformed indices', async () => {
    const { input } = await candidate()
    const bad = structuredClone(input); delete (bad.languages as any).ko_kp
    expect((await request('/snapshots',bad)).status).toBe(400)
    expect((await request('/snapshots',{ ...input, infoTypePriority: 2 })).status).toBe(400)
    for (const index of ['01','16','-1']) expect((await request(`/snapshots/${input.snapshotId}/messages/ja_jp/${index}`,undefined,
      { method: 'PUT',raw: '[]' })).status).toBeGreaterThanOrEqual(400)
    expect((await request('/latest?lang=ja_jp&lang=en_us')).status).toBe(400)
    expect((await request('/latest/meta?url=x')).status).toBe(400)
  })
  it('retains existing method restrictions', async () => {
    const ctx = createExecutionContext(); Object.defineProperty(ctx,'access',{ value: { aud: AUD } })
    expect((await app.fetch(new Request('https://example.com/internal/v1/config/snapshot',{ method: 'POST' }),{ DB: env.DB, ACCESS_AUD: AUD },ctx)).status).toBe(405)
  })
})

describe('bounded, retryable cleanup', () => {
  it('fails admission at the reserved byte cap without changing the latest pointer', async () => {
    await lease(); const first = await candidate(); await stage(first); await commit(first.input.snapshotId)
    await env.DB.prepare('UPDATE quake_snapshots SET expected_bytes = ?').bind(256 * 1024 * 1024).run()
    const next = await candidate({ publisherSequence: 2, serial: 2 })
    expect((await request('/snapshots',next.input)).status).toBe(503)
    expect((await published()).snapshot?.snapshotId).toBe(first.input.snapshotId)
  })
  it('protects the current snapshot and retains recently retired data for 24 hours; never changes channels_revision', async () => {
    await lease(); const before = await env.DB.prepare('SELECT channels_revision FROM config_meta WHERE id = 1').first('channels_revision')
    const first = await candidate(); await stage(first); await commit(first.input.snapshotId)
    await env.DB.prepare('UPDATE quake_snapshots SET created_at = 0, committed_at = 0').run()
    const next = await candidate({ publisherSequence: 2, serial: 2 }); await stage(next); await commit(next.input.snapshotId)
    await store.cleanup()
    expect(await env.DB.prepare('SELECT count(*) AS n FROM quake_snapshots').first('n')).toBe(2)
    const pending = await candidate({ publisherSequence: 3 }); await request('/snapshots',pending.input)
    const now = Date.now()
    await env.DB.prepare('UPDATE quake_snapshots SET created_at = ? WHERE snapshot_id = ?').bind(now - STAGING_RETENTION_MS - 10,pending.input.snapshotId).run()
    await store.cleanup(now + RETIRED_RETENTION_MS + 1_000)
    await store.cleanup(now + RETIRED_RETENTION_MS + 1_000)
    expect(await env.DB.prepare('SELECT count(*) AS n FROM quake_snapshots').first('n')).toBe(1)
    expect((await published()).snapshot?.snapshotId).toBe(next.input.snapshotId)
    expect(await env.DB.prepare('SELECT channels_revision FROM config_meta WHERE id = 1').first('channels_revision')).toBe(before)
  })
})
