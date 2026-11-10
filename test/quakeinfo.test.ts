import { applyD1Migrations, createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from '../src/env'
import { LANGUAGES } from '../src/i18n/languages'
import { app } from '../src/index'
import { QuakeStore } from '../src/quakeinfo/store'
import { MAX_MESSAGE_BYTES, MAX_MESSAGES, MAX_REPORT_BYTES, quakeReport, utf8Length } from '../src/quakeinfo/validation'
import { resetDb } from './support/fixtures'

const AUD = 'synthetic-common-aud'
const store = new QuakeStore(env.DB)

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))
beforeEach(() => resetDb(env.DB))
afterEach(() => vi.restoreAllMocks())

async function request(
  path: string,
  options: { method?: string; body?: unknown; raw?: string; aud?: string | null; bindings?: Bindings } = {},
) {
  const ctx = createExecutionContext()
  Object.defineProperty(ctx, 'access', { value: options.aud === null ? undefined : { aud: options.aud ?? AUD } })
  const response = await app.fetch(
    new Request(`https://example.com/internal/v2/quakeinfo${path}`, {
      method: options.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    }),
    options.bindings ?? { DB: env.DB, ACCESS_AUD: AUD },
    ctx,
  )
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return response
}

function report(overrides: Record<string, unknown> = {}, counts = [3, 2, 1, 2, 1]) {
  return {
    eventId: '20260101000000',
    reportType: 'VXSE53',
    reportDateTime: '2026-01-01T00:00:00Z',
    dateTime: '2026-01-01T00:00:00Z',
    serial: 1,
    infoType: '発表',
    languages: Object.fromEntries(
      LANGUAGES.map(({ code }, l) => [
        code,
        Array.from({ length: counts[l] ?? 1 }, (_, i) => [{ title: `TEST ${code} ${i}`, description: 'fixture' }]),
      ]),
    ),
    ...overrides,
  }
}

async function publish(body: unknown) {
  const response = await request('/latest', { method: 'PUT', body })
  return { status: response.status, json: (await response.json()) as { accepted?: boolean; revision?: number } }
}

async function latest(lang = 'ja_jp') {
  return (await (await request(`/latest?lang=${lang}`)).json()) as {
    revision: number
    snapshot: Record<string, unknown> | null
    messages: { messageIndex: number; embeds: { title: string }[] }[]
  }
}

describe('PUT /latest', () => {
  it('stores every language with its own message count and serves them in order', async () => {
    expect(await publish(report())).toEqual({ status: 200, json: { accepted: true, revision: 1 } })
    const ja = await latest('ja_jp')
    expect(ja.messages.map((m) => m.messageIndex)).toEqual([0, 1, 2])
    expect(ja.messages[2]?.embeds[0]?.title).toBe('TEST ja_jp 2')
    expect(ja.snapshot).toEqual({
      eventId: '20260101000000',
      reportType: 'VXSE53',
      reportDateTime: '2026-01-01T00:00:00.000000000Z',
      dateTime: '2026-01-01T00:00:00.000000000Z',
      serial: 1,
      infoType: '発表',
      infoTypePriority: 0,
      updatedAt: expect.any(Number),
    })
    expect((await latest('zh_tw')).messages).toHaveLength(1)
  })

  it('replaces the report and drops its old messages', async () => {
    await publish(report())
    expect((await publish(report({ serial: 2 }, [1, 1, 1, 1, 1]))).json).toEqual({ accepted: true, revision: 2 })
    expect((await latest()).messages).toHaveLength(1)
    const count = await env.DB.prepare('SELECT count(*) AS n FROM quake_messages').first<number>('n')
    expect(count).toBe(5)
  })

  it.each([
    ['an older serial', { serial: 0 }],
    ['an older report time', { reportDateTime: '2025-12-31T23:59:59.999Z' }],
    ['a lower info type priority at the same serial', { infoType: '発表' }],
  ])('ignores %s', async (_, overrides) => {
    await publish(report({ infoType: '訂正' }))
    const before = await latest()
    expect((await publish(report(overrides, [1, 1, 1, 1, 1]))).json).toEqual({ accepted: false, revision: 1 })
    expect(await latest()).toEqual(before)
  })

  it('accepts an equal key with new content as a re-render', async () => {
    await publish(report())
    expect((await publish(report({}, [1, 1, 1, 1, 1]))).json).toEqual({ accepted: true, revision: 2 })
    expect((await latest()).messages).toHaveLength(1)
  })

  it('accepts an identical re-publication without a new revision', async () => {
    await publish(report())
    const before = await latest()
    expect((await publish(report({ dateTime: '2026-01-01T00:00:00.000Z' }))).json).toEqual({
      accepted: true,
      revision: 1,
    })
    expect(await latest()).toEqual(before)
  })

  it('orders null times before any time, like Java', async () => {
    await publish(report({ reportDateTime: null, dateTime: null, serial: 9 }))
    expect((await publish(report({ serial: 1 }))).json.accepted).toBe(true)
  })

  it('compares fractional seconds after normalization', async () => {
    await publish(report({ reportDateTime: '2026-01-01T00:00:00.5Z' }))
    expect((await publish(report({ reportDateTime: '2026-01-01T00:00:00.123456789Z' }))).json.accepted).toBe(false)
    expect((await publish(report({ reportDateTime: '2026-01-01T00:00:00.500000001Z' }))).json.accepted).toBe(true)
  })

  it('serializes concurrent publications', async () => {
    const results = await Promise.all([1, 2, 3, 4].map((serial) => publish(report({ serial }))))
    expect(results.every((r) => r.status === 200)).toBe(true)
    const final = await latest()
    expect(final.snapshot?.serial).toBe(4)
    expect(final.messages).toHaveLength(3)
    const count = await env.DB.prepare('SELECT count(*) AS n FROM quake_messages').first<number>('n')
    expect(count).toBe(9)
  })

  it('ignores unknown fields', async () => {
    expect((await publish(report({ renderedAt: '2026-01-01T00:00:01Z', extra: true }))).status).toBe(200)
  })

  it.each([
    ['eventId', { eventId: 'bad id' }],
    ['reportType', { reportType: 'VXSE99' }],
    ['infoType', { infoType: 'x' }],
    ['serial', { serial: 2 ** 31 }],
    ['time', { dateTime: '2026-01-01 00:00:00' }],
    ['time', { reportDateTime: '2026-02-30T00:00:00Z' }],
    ['missing language', { languages: { ja_jp: [[{}]] } }],
    ['empty message list', { languages: Object.fromEntries(LANGUAGES.map(({ code }) => [code, []])) }],
    ['17 messages', { languages: Object.fromEntries(LANGUAGES.map(({ code }) => [code, Array(17).fill([{}])])) }],
    ['11 embeds', { languages: Object.fromEntries(LANGUAGES.map(({ code }) => [code, [Array(11).fill({})]])) }],
    ['non-object embed', { languages: Object.fromEntries(LANGUAGES.map(({ code }) => [code, [['x']]])) }],
  ])('rejects an invalid %s', async (_, overrides) => {
    expect(await publish(report(overrides))).toEqual({ status: 400, json: { error: { code: 'invalid_quakeinfo' } } })
    expect((await latest()).snapshot).toBeNull()
  })

  it('rejects malformed JSON', async () => {
    const response = await request('/latest', { method: 'PUT', raw: '{' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_json' } })
  })
})

describe('GET /latest', () => {
  it('returns an empty result before the first publication', async () => {
    expect(await latest()).toEqual({ revision: 0, snapshot: null, lang: 'ja_jp', messages: [] })
  })

  it('defaults to Japanese and rejects unknown languages', async () => {
    await publish(report())
    expect((await (await request('/latest')).json()) as { lang: string }).toMatchObject({ lang: 'ja_jp' })
    const response = await request('/latest?lang=xx')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_language' } })
  })
})

describe('boundary', () => {
  it('requires Access before reading the DB', async () => {
    const readDb = vi.fn(() => env.DB)
    const bindings = {
      ACCESS_AUD: AUD,
      get DB() {
        return readDb()
      },
    }
    for (const method of ['GET', 'PUT']) {
      expect(
        (await request('/latest', { method, body: method === 'PUT' ? report() : undefined, aud: null, bindings }))
          .status,
      ).toBe(403)
    }
    expect(readDb).not.toHaveBeenCalled()
  })

  it.each(['/publisher/lease', '/snapshots', '/cleanup', '/latest/meta'])('no longer serves %s', async (path) => {
    expect((await request(path, { method: 'POST', body: {} })).status).toBe(404)
  })

  it('maps D1 failures to a sanitized 503', async () => {
    const DB = {
      prepare: () => {
        throw new Error('secret SQL')
      },
    } as unknown as Bindings['DB']
    const response = await request('/latest', { bindings: { ACCESS_AUD: AUD, DB } })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'storage_unavailable' } })
  })
})

describe('QuakeStore', () => {
  it.each([1, 0])('avoids scanning current messages when publishing serial %s again', async (serial) => {
    const counts = LANGUAGES.map(() => MAX_MESSAGES)
    const current = quakeReport(report({}, counts))
    await store.publish(current)
    const before = await store.latest('ja_jp')
    const batch = vi.spyOn(env.DB, 'batch')
    const prepare = vi.spyOn(env.DB, 'prepare')

    expect(await store.publish(quakeReport(report({ serial }, counts)))).toEqual({
      accepted: serial === 1,
      revision: 1,
    })
    expect(batch).toHaveBeenCalledTimes(1)
    const results = await batch.mock.results[0]!.value
    const cleanup = results.at(-2)!
    expect(cleanup.meta.changes).toBe(0)
    expect(cleanup.meta.rows_read).toBeLessThan(LANGUAGES.length * MAX_MESSAGES)
    const sql = prepare.mock.calls.find(([sql]) => sql.startsWith('DELETE FROM quake_messages'))?.[0]
    expect(sql).toBeDefined()
    const { results: plan } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()
    expect(plan.some(({ detail }) => detail.startsWith('SCAN quake_messages'))).toBe(false)
    expect(plan.filter(({ detail }) => detail.startsWith('SEARCH quake_messages'))).toHaveLength(2)
    expect(await store.latest('ja_jp')).toEqual(before)
  })

  it.each([1, 0])(
    'still removes orphan messages on both sides of the current snapshot at serial %s',
    async (serial) => {
      await store.publish(quakeReport(report()))
      const before = await store.latest('ja_jp')
      await env.DB.batch(
        ['0', 'z'].map((id) => env.DB.prepare("INSERT INTO quake_messages VALUES (?, 'ja_jp', 0, '[]')").bind(id)),
      )
      expect(await store.publish(quakeReport(report({ serial })))).toEqual({ accepted: serial === 1, revision: 1 })
      expect(await env.DB.prepare('SELECT COUNT(DISTINCT snapshot_id) AS n FROM quake_messages').first('n')).toBe(1)
      expect(await store.latest('ja_jp')).toEqual(before)
    },
  )

  it('rolls back the whole publication when a message insert fails', async () => {
    await store.publish(quakeReport(report()))
    const before = await store.latest('ja_jp')
    await env.DB.prepare(`CREATE TRIGGER fail_message BEFORE INSERT ON quake_messages
      BEGIN SELECT RAISE(ABORT, 'fail'); END`).run()
    try {
      await expect(store.publish(quakeReport(report({ serial: 2 })))).rejects.toThrow('Storage operation failed')
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_message').run()
    }
    expect(await store.latest('ja_jp')).toEqual(before)
  })
})

describe('size limits', () => {
  /** One message whose JSON.stringify(embeds) is exactly `bytes` UTF-8 bytes, mixing 1-, 3- and 4-byte characters. */
  function messageOf(bytes: number) {
    const fixed = utf8Length(JSON.stringify([{ d: '' }])) + 4 + 3 * 1000
    const text = `🌏${'あ'.repeat(1000)}${'a'.repeat(bytes - fixed)}`
    const embeds = [{ d: text }]
    expect(utf8Length(JSON.stringify(embeds))).toBe(bytes)
    return embeds
  }

  function withJapanese(embeds: unknown[]) {
    const base = report()
    return { ...base, languages: { ...base.languages, ja_jp: [embeds] } }
  }

  async function put(body: BodyInit, headers: Record<string, string> = {}) {
    const ctx = createExecutionContext()
    Object.defineProperty(ctx, 'access', { value: { aud: AUD } })
    const response = await app.fetch(
      new Request('https://example.com/internal/v2/quakeinfo/latest', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        // @ts-expect-error duplex is required by some runtimes for stream bodies
        duplex: 'half',
      }),
      { DB: env.DB, ACCESS_AUD: AUD },
      ctx,
    )
    return { status: response.status, json: await response.json() }
  }

  it.each([
    ['ASCII', 'abc~', 4],
    ['two-byte', 'é©', 4],
    ['three-byte', 'あ震', 6],
    ['surrogate pair', '🌏😀', 8],
    ['lone surrogate', '\ud800x\udc00', 7],
  ])('counts UTF-8 bytes of %s text like TextEncoder', (_, text, bytes) => {
    expect(utf8Length(text)).toBe(bytes)
    expect(utf8Length(text)).toBe(new TextEncoder().encode(text).byteLength)
  })

  it('stores a message of exactly the row budget and rejects one byte more', async () => {
    const largest = messageOf(MAX_MESSAGE_BYTES)
    expect(await publish(withJapanese(largest))).toEqual({ status: 200, json: { accepted: true, revision: 1 } })
    const stored = await env.DB.prepare(
      "SELECT length(CAST(embeds_json AS BLOB)) AS n FROM quake_messages WHERE lang = 'ja_jp'",
    ).first<number>('n')
    expect(stored).toBe(MAX_MESSAGE_BYTES)
    expect((await latest()).messages[0]?.embeds).toEqual(largest)

    expect(await publish(withJapanese(messageOf(MAX_MESSAGE_BYTES + 1)))).toEqual({
      status: 413,
      json: { error: { code: 'body_too_large' } },
    })
    expect((await latest()).revision).toBe(1)
  })

  it('publishes a full-size report in one batch of 8 statements', async () => {
    const counts = LANGUAGES.map(() => MAX_MESSAGES)
    const full = report({}, counts)
    full.languages = Object.fromEntries(
      LANGUAGES.map(({ code }) => [
        code,
        Array.from({ length: MAX_MESSAGES }, (_, i) =>
          Array.from({ length: 10 }, (_, e) => ({ title: `${code} ${i} ${e}`, description: '震度'.repeat(500) })),
        ),
      ]),
    )
    const batch = vi.spyOn(env.DB, 'batch')
    expect(await store.publish(quakeReport(full))).toEqual({ accepted: true, revision: 1 })
    expect(batch.mock.calls[0]?.[0]).toHaveLength(8)
    for (const { code } of LANGUAGES) {
      const { messages } = await store.latest(code)
      expect(messages.map((m) => m.messageIndex)).toEqual([...Array(MAX_MESSAGES).keys()])
      expect(messages.map((m) => m.embeds)).toEqual(full.languages[code])
    }
  })

  it("accepts a report at Core's own limits (64 KiB messages, 512 KiB languages, 2 MiB of embeds)", async () => {
    // QuakeInfoSnapshot.render() counts only the embeds JSON; the body adds the envelope on top.
    const KiB = 1024
    const full = Array.from({ length: 8 }, () => messageOf(64 * KiB))
    const last = 4 * KiB
    const body = {
      ...report({ eventId: 'x'.repeat(64) }),
      languages: Object.fromEntries(
        LANGUAGES.map(({ code }, l) => [
          code,
          l < 3 ? full : l === 3 ? [...full.slice(0, 7), messageOf(64 * KiB - last)] : [messageOf(last)],
        ]),
      ),
    }
    const embeds = Object.values(body.languages)
      .flat()
      .reduce((sum, embeds) => sum + utf8Length(JSON.stringify(embeds)), 0)
    expect(embeds).toBe(2 * 1024 * KiB)
    const raw = JSON.stringify(body)
    expect(utf8Length(raw)).toBeGreaterThan(2 * 1024 * KiB)
    expect(utf8Length(raw)).toBeLessThanOrEqual(MAX_REPORT_BYTES)
    expect(await put(raw, { 'Content-Length': String(utf8Length(raw)) })).toEqual({
      status: 200,
      json: { accepted: true, revision: 1 },
    })
  })

  it('rejects a declared body over the request limit before reading it', async () => {
    expect(await put('{}', { 'Content-Length': String(MAX_REPORT_BYTES + 1) })).toEqual({
      status: 413,
      json: { error: { code: 'body_too_large' } },
    })
  })

  it('rejects a streamed body once it passes the request limit', async () => {
    const chunk = new TextEncoder().encode(' '.repeat(1024 * 1024))
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_REPORT_BYTES + chunk.byteLength) return controller.close()
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    expect(await put(body)).toEqual({ status: 413, json: { error: { code: 'body_too_large' } } })
    expect(sent).toBeLessThanOrEqual(MAX_REPORT_BYTES + 2 * chunk.byteLength)
    expect((await latest()).snapshot).toBeNull()
  })

  it('accepts a streamed body at the request limit', async () => {
    const json = new TextEncoder().encode(JSON.stringify(report()))
    const padded = new Uint8Array(MAX_REPORT_BYTES).fill(0x20)
    padded.set(json)
    expect((await put(new Blob([padded]).stream())).status).toBe(200)
  })
})
