import { applyD1Migrations, createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from '../src/env'
import { LANGUAGES } from '../src/i18n/languages'
import { app } from '../src/index'
import { QuakeStore } from '../src/quakeinfo/store'
import { quakeReport } from '../src/quakeinfo/validation'
import { resetDb } from './support/fixtures'

const AUD = 'synthetic-common-aud'
const store = new QuakeStore(env.DB)

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))
beforeEach(() => resetDb(env.DB))

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

  it('accepts an equal key as a retry or re-render', async () => {
    await publish(report())
    expect((await publish(report({}, [1, 1, 1, 1, 1]))).json).toEqual({ accepted: true, revision: 2 })
    expect((await latest()).messages).toHaveLength(1)
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
