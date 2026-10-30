import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import type { Bindings } from '../src/env'
import type { Interaction } from '../src/discord/types'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import { QuakeStore } from '../src/quakeinfo/store'
import { encoder, sha256, snapshotInput } from '../src/quakeinfo/validation'
import { LANGUAGES } from '../src/i18n/languages'

const APP = '1234567890123456780', GUILD = '1234567890123456781', CHANNEL = '1234567890123456782'
const THREAD = '1234567890123456783', USER = '1234567890123456784'
const store = new D1DestinationStore(env.DB), quakes = new QuakeStore(env.DB)
let key: CryptoKey, bindings: Bindings
let calls: { method: string; url: string; body: any }[]
beforeAll(async () => {
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS)
  const pair = await crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as CryptoKeyPair
  key = pair.privateKey
  const publicKey = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)),(n) => n.toString(16).padStart(2,'0')).join('')
  bindings = { DB: env.DB,DISCORD_PUBLIC_KEY: publicKey,DISCORD_APPLICATION_ID: APP,DISCORD_COMMANDS_ENABLED: 'true' }
})
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('UPDATE quake_latest SET snapshot_id = NULL, quake_revision = 0'),
    env.DB.prepare('DELETE FROM quake_snapshots'),env.DB.prepare('DELETE FROM quake_publisher_leases'),
    env.DB.prepare('UPDATE quake_publisher_state SET publisher_epoch = 0'),env.DB.prepare('DELETE FROM quake_interactions'),
    env.DB.prepare('DELETE FROM destinations'),env.DB.prepare('UPDATE config_meta SET channels_revision = 0 WHERE id = 1'),
  ])
  await quakes.lease(crypto.randomUUID())
  calls = []
  vi.stubGlobal('fetch',vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe('https://discord.com')
    expect(url).toContain(`/webhooks/${APP}/synthetic-token`)
    expect(new Headers(init.headers).has('Authorization')).toBe(false)
    calls.push({ method: init.method!,url,body: JSON.parse(init.body as string) })
    return Response.json({ id: USER })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function command(overrides: Partial<Interaction> = {}): Interaction {
  return { type: 2,id: USER,application_id: APP,guild_id: GUILD,channel_id: CHANNEL,context: 0,
    authorizing_integration_owners: { '0': GUILD },token: 'synthetic-token',member: { user: { id: USER },permissions: '0' },data: { name: 'quakeinfo' },...overrides }
}
async function execute(i = command(), options: { badSignature?: boolean; env?: Bindings } = {}) {
  const body = JSON.stringify(i), timestamp = String(Math.floor(Date.now() / 1000))
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('Ed25519',key,encoder.encode(timestamp + body))),n => n.toString(16).padStart(2,'0')).join('')
  const ctx = createExecutionContext()
  const response = await app.fetch(new Request('https://local/interactions',{ method: 'POST',body,headers: {
    'X-Signature-Ed25519': options.badSignature ? '0'.repeat(128) : signature,'X-Signature-Timestamp': timestamp,
  } }),options.env ?? bindings,ctx)
  const result = { status: response.status, body: response.status === 200 ? await response.json() as any : null }
  await waitOnExecutionContext(ctx)
  return result
}
async function publish(sequence = 1, infoType = '発表') {
  const bodies = Object.fromEntries(LANGUAGES.map(({ code }, l) => [code,Array.from({ length: l === 0 ? 3 : 2 },(_,index) =>
    JSON.stringify([{ title: `TEST ${sequence} ${code} ${index}`,description: infoType === '取消' ? '先程の地震情報を取り消します。' : 'Synthetic test data',
      timestamp: '2000-01-01T00:00:00Z',image: { url: 'https://renderer.example.test/test.png' } }]))]))
  const languages: Record<string,unknown> = {}, lines: string[] = []
  for (const { code } of LANGUAGES) {
    const entries = []
    for (const [i,body] of bodies[code].entries()) {
      const contentHash = await sha256(body),byteLength = encoder.encode(body).byteLength
      entries.push({ contentHash,byteLength }); lines.push(`${code}:${i}:${contentHash}:${byteLength}\n`)
    }
    languages[code] = entries
  }
  const input = await snapshotInput({ snapshotId: crypto.randomUUID(),schemaVersion: 1,eventId: 'test-event',reportType: 'VXSE53',
    reportDateTime: '2000-01-01T00:00:00Z',dateTime: '2000-01-01T00:00:00Z',serial: sequence,
    infoType,infoTypePriority: infoType === '取消' ? 2 : infoType === '訂正' ? 1 : 0,isCancel: infoType === '取消',
    renderedAt: '2000-01-01T00:00:01Z',publisherEpoch: 1,publisherSequence: sequence,contentHash: await sha256(lines.join('')),languages })
  await quakes.create(input)
  for (const { code } of LANGUAGES) for (const [i,body] of bodies[code].entries()) await quakes.put(input.snapshotId,code,i,body)
  await quakes.commit(input.snapshotId)
  return input
}

describe('public /quakeinfo using only saved D1 embeds', () => {
  it('allows ordinary members, immediately publicly defers and edits original then sends ordered followups', async () => {
    await publish()
    const before = await store.loadSnapshot(), result = await execute()
    expect(result.body).toEqual({ type: 5,data: { allowed_mentions: { parse: [] } } })
    expect(calls.map((c) => c.method)).toEqual(['PATCH','POST','POST'])
    expect(calls[0].url).toContain('/messages/@original')
    expect(calls.slice(1).every((c) => c.url.endsWith('?wait=true'))).toBe(true)
    expect(calls.map((c) => c.body.embeds[0].title)).toEqual([0,1,2].map((i) => `TEST 1 ja_jp ${i}`))
    for (const call of calls) expect(call.body.allowed_mentions).toEqual({ parse: [] })
    expect(calls[0].body.content).toContain('発表日時: <t:946684800:F>')
    expect(calls[0].body.content).toContain('過去に発表された情報')
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it.each(LANGUAGES)('uses $code from a registered channel without changing configuration', async ({ code }) => {
    await publish(); await store.insertDestinationIfAbsent({ targetId: CHANNEL,channelId: CHANNEL,guildId: GUILD,lang: code })
    const before = await store.loadSnapshot(); await execute()
    expect(calls[0].body.embeds[0].title).toBe(`TEST 1 ${code} 0`)
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it('uses the thread setting independently of its parent', async () => {
    await publish()
    await store.insertDestinationIfAbsent({ targetId: CHANNEL,channelId: CHANNEL,guildId: GUILD,lang: 'en_us' })
    await store.insertDestinationIfAbsent({ targetId: THREAD,channelId: CHANNEL,threadId: THREAD,guildId: GUILD,lang: 'ko_kp' })
    await execute(command({ channel_id: THREAD }))
    expect(calls[0].body.embeds[0].title).toBe('TEST 1 ko_kp 0')
  })
  it.each(['unknown','foreign'])('falls back to Japanese for %s destination language/ownership', async (kind) => {
    await publish(); await store.insertDestinationIfAbsent({ targetId: CHANNEL,channelId: CHANNEL,guildId: kind === 'foreign' ? USER : GUILD,lang: kind === 'foreign' ? 'en_us' : 'legacy' })
    const before = await store.loadSnapshot(); await execute()
    expect(calls[0].body.embeds[0].title).toBe('TEST 1 ja_jp 0'); expect(await store.loadSnapshot()).toEqual(before)
  })
  it('returns the Java-equivalent no-data guidance as a documented public error after defer', async () => {
    const result = await execute()
    expect(result.body.data.flags).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0].body.content).toBe('地震情報を取得できませんでした。時間をあけて再度お試しください。')
    expect(calls[0].body.flags).toBeUndefined()
  })
  it.each(['訂正','取消'])('preserves %s metadata, image and cancellation text', async (info) => {
    await publish(1,info); await execute()
    expect(calls[0].body.content).toContain(info)
    expect(calls[0].body.embeds[0].image.url).toBe('https://renderer.example.test/test.png')
    if (info === '取消') expect(calls[0].body.embeds[0].description).toContain('取り消')
  })
  it('does not mix snapshots if another commit occurs while followups are being delivered', async () => {
    await publish()
    const originalFetch = fetch
    vi.stubGlobal('fetch',vi.fn(async (url: string, init: RequestInit) => {
      if (calls.length === 0) await publish(2)
      return originalFetch(url,init)
    }))
    await execute()
    expect(calls.map((c) => c.body.embeds[0].title)).toEqual([0,1,2].map((i) => `TEST 1 ja_jp ${i}`))
    expect((await quakes.latestMeta()).revision).toBe(2)
  })
  it('does not retry ambiguous POSTs, restart sent pages, or replay duplicate signed interactions', async () => {
    await publish()
    const originalFetch = fetch
    vi.stubGlobal('fetch',vi.fn(async (url: string, init: RequestInit) => {
      const response = await originalFetch(url,init)
      if (init.method === 'POST') throw new Error('synthetic token-bearing URL secret')
      return response
    }))
    await execute()
    expect(calls.map((c) => c.method)).toEqual(['PATCH','POST','PATCH'])
    expect(calls[2].body.content).toContain('一部の情報を送信できませんでした')
    expect(calls[2].body.embeds).toEqual(calls[0].body.embeds)
    const count = calls.length
    await execute()
    expect(calls).toHaveLength(count)
    expect(JSON.stringify(calls)).not.toContain('token-bearing')
  })
  it('continues serving a saved snapshot without any Java or webhook-sender request', async () => {
    await publish(); await execute()
    expect(calls.every((call) => new URL(call.url).origin === 'https://discord.com')).toBe(true)
  })
  it('sanitizes storage errors while leaving a public error response', async () => {
    const db = { withSession() { throw new Error('private SQL secret') } } as unknown as D1Database
    await execute(command(),{ env: { ...bindings,DB: db } })
    expect(calls[0].body.content).not.toContain('secret')
  })
  it('rejects signature, guild/application and context violations before D1 or REST', async () => {
    expect((await execute(command(),{ badSignature: true })).status).toBe(401)
    for (const overrides of [{ guild_id: USER },{ application_id: USER },{ context: 1 },{ authorizing_integration_owners: {} },{ member: undefined }]) {
      const readDb = vi.fn(() => env.DB)
      const result = await execute(command(overrides),{ env: { ...bindings,get DB() { return readDb() } } })
      expect(result.body.type).toBe(4); expect(result.body.data.flags).toBe(64); expect(readDb).not.toHaveBeenCalled()
    }
    expect(calls).toHaveLength(0)
  })
})

it('serves the same latest snapshot to two signed Guild Installs using each destination language', async () => {
  await publish()
  const guildB = '2234567890123456781', channelB = '2234567890123456782'
  await store.insertDestinationIfAbsent({ targetId: CHANNEL, channelId: CHANNEL, guildId: GUILD, lang: 'en_us' })
  await store.insertDestinationIfAbsent({ targetId: channelB, channelId: channelB, guildId: guildB, lang: 'ko_kp' })
  const before = await quakes.latestMeta()
  for (const [guild_id, channel_id, lang, id] of [[GUILD, CHANNEL, 'en_us', USER], [guildB, channelB, 'ko_kp', channelB]]) {
    calls = []
    await execute(command({ id, guild_id, channel_id, authorizing_integration_owners: { '0': guild_id } }))
    expect(calls[0].body.embeds[0].title).toBe(`TEST 1 ${lang} 0`)
  }
  expect(await quakes.latestMeta()).toEqual(before)
})
