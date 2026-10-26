import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import type { Destination, NewDestination } from '../src/db/destination-types'
import type { LanguageSessionGuard } from '../src/db/destination-store'
import { DiscordState } from '../src/discord/state'
import type { Interaction, Target } from '../src/discord/types'
import type { Bindings } from '../src/env'
import { displayLanguage, LANGUAGES, translate, type LanguageCode } from '../src/i18n/languages'

const APP = '1234567890123456780', GUILD = '1234567890123456789'
const CHANNEL = '1234567890123456790', THREAD = '1234567890123456791', SECOND = '1234567890123456792'
const ACTOR = '1234567890123456793', OTHER = '1234567890123456794', HOOK = '1234567890123456795'
const SECRET = 'synthetic-webhook-secret', BOT = 'synthetic-bot-secret'
const URL = `https://discord.com/api/webhooks/${HOOK}/${SECRET}`
const target: Target = { targetId: CHANNEL, channelId: CHANNEL, threadId: null, guildId: GUILD }
const threadTarget: Target = { ...target, targetId: THREAD, threadId: THREAD }
const store = new D1DestinationStore(env.DB), state = new DiscordState(env.DB)
const FULL: NewDestination = { ...target, eewAlert: true, eewPrediction: true, eewDecimation: true, quakeInfo: true,
  tsunami: true, minIntensity: 8, webhookUrl: URL, lang: 'en_us' }
type Component = { custom_id: string; type: number; label?: string; disabled?: boolean;
  options?: { label: string; value: string; default: boolean }[]; min_values?: number; max_values?: number }
type Reply = { content: string; components: { components: Component[] }[]; allowed_mentions: { parse: unknown[] } }
let privateKey: CryptoKey, publicKey: string, bindings: Bindings, sequence = 0
let replies: Map<string, Reply>, calls: { path: string; method: string }[], unexpected: string[]
let channelOverride: Record<string, unknown>, faults: Map<string, number[]>

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  privateKey = keys.privateKey
  publicKey = hex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
})
beforeEach(async () => {
  await env.DB.batch(['DELETE FROM destinations', 'DELETE FROM discord_sessions', 'DELETE FROM discord_language_sessions',
    'DELETE FROM discord_interaction_receipts', 'DELETE FROM discord_setup_locks',
    'UPDATE config_meta SET channels_revision = 0 WHERE id = 1'].map((sql) => env.DB.prepare(sql)))
  bindings = { DB: env.DB, DISCORD_PUBLIC_KEY: publicKey, DISCORD_BOT_TOKEN: BOT, DISCORD_COMMANDS_ENABLED: 'true',
    DISCORD_APPLICATION_ID: APP, DISCORD_TEST_GUILD_ID: GUILD }
  replies = new Map(); calls = []; unexpected = []; channelOverride = {}; faults = new Map()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new globalThis.URL(String(input))
    expect(url.origin).toBe('https://discord.com'); expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeDefined()
    const path = url.pathname.replace('/api/v10', ''), method = init?.method ?? 'GET'
    calls.push({ path, method })
    expect(new Headers(init?.headers).get('Authorization')).toBe(path.endsWith('/messages/@original') ? null : `Bot ${BOT}`)
    const fault = faults.get(method + ' ' + path)?.shift()
    if (fault) return new Response(SECRET + URL, { status: fault })
    if (method === 'PATCH' && path.endsWith('/messages/@original')) {
      replies.set(path.split('/')[3], JSON.parse(String(init?.body))); return Response.json({ id: ACTOR })
    }
    if (path === '/oauth2/applications/@me') return Response.json({ id: APP })
    if (path === `/channels/${CHANNEL}`) return Response.json({ id: CHANNEL, guild_id: GUILD, type: 0, ...channelOverride })
    if (path === `/channels/${SECOND}`) return Response.json({ id: SECOND, guild_id: GUILD, type: 0 })
    if (path === `/channels/${THREAD}`) return Response.json({ id: THREAD, guild_id: GUILD, type: 11, parent_id: CHANNEL })
    unexpected.push(path); throw new Error(SECRET)
  }))
})
afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS language_failure').run()
  await env.DB.prepare('DROP TRIGGER IF EXISTS revision_failure').run()
  expect(unexpected).toEqual([])
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
function hex(value: Uint8Array) { return Array.from(value).map((n) => n.toString(16).padStart(2, '0')).join('') }
function command(overrides: Partial<Interaction> = {}): Interaction {
  sequence++
  return { type: 2, id: String(1234567890123500000n + BigInt(sequence)), application_id: APP, guild_id: GUILD,
    channel_id: CHANNEL, token: 'synthetic-language-token-' + sequence, context: 0, authorizing_integration_owners: { '0': GUILD },
    member: { permissions: '32', user: { id: ACTOR } }, app_permissions: '0', data: { name: 'lang' }, ...overrides }
}
async function execute(i = command(), settings = bindings, badSignature = false) {
  const body = JSON.stringify(i), timestamp = String(Math.floor(Date.now() / 1000))
  const signature = hex(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + body))))
  const ctx = createExecutionContext()
  const response = await app.fetch(new Request('https://local/interactions', { method: 'POST', body, headers: {
    'X-Signature-Ed25519': badSignature ? '0'.repeat(128) : signature, 'X-Signature-Timestamp': timestamp,
  } }), settings, ctx)
  const ack = await response.json() as { type: number; data?: { content?: string; flags: number } }
  await waitOnExecutionContext(ctx)
  return { status: response.status, ack, reply: replies.get(i.token!)! }
}
function component(reply: Reply, index = 0) { return reply.components[index].components[0] }
function select(reply: Reply, values: unknown, overrides: Partial<Interaction> = {}) {
  return command({ type: 3, data: { custom_id: component(reply).custom_id, component_type: 3, values }, ...overrides })
}
function apply(reply: Reply, overrides: Partial<Interaction> = {}) {
  return command({ type: 3, data: { custom_id: component(reply, 1).custom_id, component_type: 2 }, ...overrides })
}
function withoutLanguage(d: Destination | null) { const { lang: _lang, ...rest } = d!; return rest }
async function seedGuild() {
  for (const destination of [FULL, { ...target, targetId: SECOND, channelId: SECOND, lang: 'ja_jp' },
    { ...threadTarget, lang: 'ko_kp', webhookUrl: URL + `?thread_id=${THREAD}` },
    { targetId: OTHER, channelId: OTHER, guildId: OTHER, lang: 'zh_tw' },
    { targetId: HOOK, channelId: HOOK, guildId: null, lang: 'ko_hanja' }]) await store.insertDestinationIfAbsent(destination)
}
async function guard(language = 'en_us'): Promise<LanguageSessionGuard> {
  const revision = await store.getRevision()
  return { id: await state.createLanguageSession(ACTOR, target, revision, language), actorId: ACTOR, revision, language }
}

describe('language menu and Java translations', () => {
  it('uses exactly the five canonical Java-compatible languages', () => {
    expect(LANGUAGES.map(({ code, name }) => [code, name])).toEqual([
      ['ja_jp', '日本語'], ['en_us', 'English, US'], ['zh_tw', '中文（台灣）'], ['ko_hanja', '한자'], ['ko_kp', '조선어'],
    ])
    expect(translate('en_us', 'stale')).toBe(translate('ja_jp', 'stale'))
    expect(displayLanguage('unknown').code).toBe('ja_jp')
  })
  it('registers an absent channel with exact defaults and never manages webhooks', async () => {
    const { ack, reply } = await execute()
    expect(ack).toEqual({ type: 5, data: { flags: 64, allowed_mentions: { parse: [] } } })
    expect(await store.getDestination(CHANNEL)).toEqual({ ...target, eewAlert: false, eewPrediction: false,
      eewDecimation: false, quakeInfo: false, tsunami: false, minIntensity: 1, lang: 'ja_jp', webhookUrl: null, webhookId: null })
    expect(component(reply)).toMatchObject({ type: 3, min_values: 1, max_values: 1 })
    expect(component(reply).options?.filter((o) => o.default).map((o) => o.value)).toEqual(['ja_jp'])
    expect(await store.getRevision()).toBe(1)
    expect(calls.every((c) => c.method !== 'POST' && c.method !== 'DELETE' && !c.path.includes('/roles'))).toBe(true)
    for (const row of reply.components) expect(row.components[0].custom_id.length).toBeLessThanOrEqual(100)
    expect(reply.allowed_mentions).toEqual({ parse: [] })
  })
  it.each(LANGUAGES)('selects and persists $code with a new session and translated response', async ({ code, name }) => {
    const { reply } = await execute()
    const changed = await execute(select(reply, [code]))
    expect(changed.ack).toEqual({ type: 6 })
    expect((await store.getDestination(CHANNEL))?.lang).toBe(code)
    expect(changed.reply.content).toContain(`**${name}**`)
    expect(component(changed.reply).options?.filter((o) => o.default).map((o) => o.value)).toEqual([code])
    expect(component(changed.reply).custom_id).not.toBe(component(reply).custom_id)
    expect(component(changed.reply, 1).label).toBe(translate(code, 'applyLabel'))
    expect(await store.getRevision()).toBe(2)
  })
  it.each([[], ['en_us', 'en_us'], ['en_us', 'ja_jp'], ['xx'], ['en_US'], ['JA_JP'], [1], [null]].map((values) => ({ values })))
    ('rejects invalid select values $values', async ({ values }) => {
      const { reply } = await execute(); const before = await store.loadSnapshot()
      const changed = await execute(select(reply, values))
      expect(changed.reply.components).toEqual([]); expect(await store.loadSnapshot()).toEqual(before)
    })
  it.each([undefined, {}, 'en_us', 1, null].map((values) => ({ values })))('rejects nonarray selection $values', async ({ values }) => {
    const { reply } = await execute(); const before = await store.loadSnapshot()
    await execute(select(reply, values)); expect(await store.loadSnapshot()).toEqual(before)
  })
  it('preserves every existing configuration field when opened or changed', async () => {
    await store.insertDestinationIfAbsent(FULL)
    const before = await store.getDestination(CHANNEL), revision = await store.getRevision()
    const { reply } = await execute()
    expect(await store.getRevision()).toBe(revision); expect(await store.getDestination(CHANNEL)).toEqual(before)
    expect(component(reply).options?.find((o) => o.default)?.value).toBe('en_us')
    await execute(select(reply, ['zh_tw']))
    expect(withoutLanguage(await store.getDestination(CHANNEL))).toEqual(withoutLanguage(before))
    expect(await store.getRevision()).toBe(revision + 1)
  })
  it('registers and edits a thread independently of its parent', async () => {
    await store.insertDestinationIfAbsent(FULL)
    const before = await store.getDestination(CHANNEL)
    const { reply } = await execute(command({ channel_id: THREAD }))
    expect(await store.getDestination(THREAD)).toMatchObject({ ...threadTarget, lang: 'ja_jp', webhookUrl: null })
    await execute(select(reply, ['ko_kp'], { channel_id: THREAD }))
    expect((await store.getDestination(THREAD))?.lang).toBe('ko_kp')
    expect(await store.getDestination(CHANNEL)).toEqual(before)
  })
  it('leaves unknown legacy codes untouched and disallows bulk fallback until explicitly selected', async () => {
    await store.insertDestinationIfAbsent({ ...FULL, lang: 'legacy-unknown' })
    const { reply } = await execute(); const before = await store.loadSnapshot()
    expect(component(reply).options?.find((o) => o.default)?.value).toBe('ja_jp')
    expect(component(reply, 1).disabled).toBe(true)
    await execute(apply(reply)); expect(await store.loadSnapshot()).toEqual(before)
    const changed = await execute(select(reply, ['ja_jp']))
    expect((await store.getDestination(CHANNEL))?.lang).toBe('ja_jp')
    expect(component(changed.reply, 1).disabled).toBe(false)
  })
  it('keeps same-language setter revision semantics', async () => {
    const { reply } = await execute(); await execute(select(reply, ['ja_jp']))
    expect(await store.getRevision()).toBe(2)
  })
  it('suppresses identical select retries without advancing revision twice', async () => {
    const { reply } = await execute(); const request = select(reply, ['en_us'])
    await execute(request); const before = await store.loadSnapshot(); calls = []
    await execute(request)
    expect(await store.loadSnapshot()).toEqual(before); expect(calls).toEqual([])
  })
  it('does not retry an uncertain committed write or expose its raw exception', async () => {
    const { reply } = await execute(); const request = select(reply, ['en_us'])
    const original = D1DestinationStore.prototype.changeLanguageFromSession
    const mutation = vi.spyOn(D1DestinationStore.prototype, 'changeLanguageFromSession').mockImplementation(async function(this: D1DestinationStore, t, s, l, scope) {
      await original.call(this, t, s, l, scope)
      throw new Error(URL + BOT)
    })
    const result = await execute(request)
    expect(result.reply.components).toEqual([]); expect(result.reply.content).not.toContain(SECRET)
    expect(result.reply.content).not.toContain(BOT)
    expect((await store.getDestination(CHANNEL))?.lang).toBe('en_us')
    await execute(request)
    expect(mutation).toHaveBeenCalledTimes(1); expect(await store.getRevision()).toBe(2)
  })
})

describe('guild language application', () => {
  it('updates only lang for same-guild channels/threads and returns the matched count', async () => {
    await seedGuild(); const before = await store.loadSnapshot(); const { reply } = await execute()
    const result = await execute(apply(reply)); const after = await store.loadSnapshot()
    expect(after.revision).toBe(before.revision + 1)
    expect(result.reply.content).toContain('Updated destinations: 3')
    for (const destination of after.destinations) {
      const original = before.destinations.find((d) => d.targetId === destination.targetId)!
      expect(withoutLanguage(destination)).toEqual(withoutLanguage(original))
      expect(destination.lang).toBe(original.guildId === GUILD ? 'en_us' : original.lang)
    }
    expect(after.destinations).toHaveLength(5)
    expect(component(result.reply).custom_id).not.toBe(component(reply).custom_id)
  })
  it('applies to more than 100 destinations with one revision increment', async () => {
    await store.insertDestinationIfAbsent(FULL)
    for (let i = 0; i < 110; i++) {
      const id = String(1234567890123457000n + BigInt(i))
      await store.insertDestinationIfAbsent({ targetId: id, channelId: id, guildId: GUILD, lang: 'ko_kp' })
    }
    const { reply } = await execute(); const revision = await store.getRevision()
    const result = await execute(apply(reply))
    expect(result.reply.content).toContain('Updated destinations: 111')
    expect(await store.getRevision()).toBe(revision + 1)
    expect((await store.getAllDestinations()).every((d) => d.lang === 'en_us')).toBe(true)
  })
  it('counts same-language matches and never inserts unregistered targets', async () => {
    await store.insertDestinationIfAbsent(FULL)
    const { reply } = await execute(); await execute(apply(reply))
    expect(await store.getRevision()).toBe(2); expect(await store.getAllDestinations()).toHaveLength(1)
  })
  it('does not repeat a bulk write for an identical interaction retry', async () => {
    await seedGuild(); const { reply } = await execute(); const request = apply(reply)
    await execute(request); const before = await store.loadSnapshot(); calls = []
    await execute(request)
    expect(await store.loadSnapshot()).toEqual(before); expect(calls).toEqual([])
  })
  it('only allows one of two competing languages to win a guild update', async () => {
    await seedGuild(); await store.setLanguage(SECOND, 'zh_tw')
    const first = await execute(), second = await execute(command({ channel_id: SECOND }))
    const revision = await store.getRevision()
    const results = await Promise.all([execute(apply(first.reply)), execute(apply(second.reply, { channel_id: SECOND }))])
    expect(results.filter((r) => r.reply.components.length === 2)).toHaveLength(1)
    expect(results.filter((r) => r.reply.components.length === 0)).toHaveLength(1)
    expect(await store.getRevision()).toBe(revision + 1)
    expect(new Set((await store.getAllDestinations()).filter((d) => d.guildId === GUILD).map((d) => d.lang)).size).toBe(1)
  })
  it('rolls back every row and revision when any row update fails', async () => {
    await seedGuild(); const { reply } = await execute(); const before = await store.loadSnapshot()
    await env.DB.prepare(`CREATE TRIGGER language_failure BEFORE UPDATE OF lang ON destinations
      WHEN OLD.target_id = '${SECOND}' BEGIN SELECT RAISE(ABORT, 'synthetic-webhook-secret'); END`).run()
    const result = await execute(apply(reply))
    expect(result.reply.components).toEqual([]); expect(await store.loadSnapshot()).toEqual(before)
    expect(result.reply.content).not.toContain(SECRET)
  })
  it('rolls back a successful language mutation when revision update fails', async () => {
    const { reply } = await execute(); const before = await store.loadSnapshot()
    await env.DB.prepare(`CREATE TRIGGER revision_failure BEFORE UPDATE ON config_meta
      BEGIN SELECT RAISE(ABORT, 'synthetic-webhook-secret'); END`).run()
    await execute(select(reply, ['en_us'])); expect(await store.loadSnapshot()).toEqual(before)
  })
})

describe('signature, permission and component isolation', () => {
  it('rejects invalid signatures before storage or REST', async () => {
    const db = vi.fn(() => env.DB)
    // A plain 401 body is intentionally not parsed by execute().
    const ctx = createExecutionContext()
    const response = await app.fetch(new Request('https://local/interactions', { method: 'POST', body: JSON.stringify(command()),
      headers: { 'X-Signature-Ed25519': '0'.repeat(128), 'X-Signature-Timestamp': String(Math.floor(Date.now() / 1000)) } }),
      { ...bindings, get DB() { return db() } }, ctx)
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(401); expect(db).not.toHaveBeenCalled(); expect(calls).toEqual([])
  })
  it.each([{ application_id: OTHER }, { guild_id: OTHER }, { context: 1, guild_id: undefined },
    { context: 2 }, { authorizing_integration_owners: { '1': ACTOR } },
    { member: { permissions: '0', user: { id: ACTOR } } },
    { member: { permissions: 'NaN', user: { id: ACTOR } } },
    { data: { name: 'lang', options: [{ name: 'guild', value: OTHER }] } }] as Partial<Interaction>[])
    ('rejects unauthorized command context %j', async (overrides) => {
      const db = vi.fn(() => env.DB)
      const { ack } = await execute(command(overrides), { ...bindings, get DB() { return db() } })
      expect(ack.type).toBe(4); expect(ack.data?.flags).toBe(64)
      expect(db).not.toHaveBeenCalled(); expect(calls).toEqual([])
    })
  it('allows administrator without Manage Guild', async () => {
    const { reply } = await execute(command({ member: { permissions: '8', user: { id: ACTOR } } }))
    expect(reply.components).toHaveLength(2)
  })
  it.each(['select', 'apply'])('rechecks revoked permissions at %s time', async (action) => {
    const { reply } = await execute(); const before = await store.loadSnapshot(); calls = []
    const overrides = { member: { permissions: '0', user: { id: ACTOR } } }
    const result = await execute(action === 'select' ? select(reply, ['en_us'], overrides) : apply(reply, overrides))
    expect(result.ack.type).toBe(4); expect(result.ack.data?.flags).toBe(64)
    expect(calls).toEqual([]); expect(await store.loadSnapshot()).toEqual(before)
  })
  it.each(['select', 'apply'].flatMap((action) => [
    { application_id: OTHER }, { guild_id: OTHER }, { context: 1, guild_id: undefined },
    { authorizing_integration_owners: { '1': ACTOR } },
  ].map((overrides) => ({ action, overrides }))))('rechecks Application/Guild/install context for $action: $overrides', async ({ action, overrides }) => {
    const { reply } = await execute(); const before = await store.loadSnapshot(); calls = []
    const result = await execute(action === 'select' ? select(reply, ['en_us'], overrides) : apply(reply, overrides))
    expect(result.ack.type).toBe(4); expect(calls).toEqual([])
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it.each([{ DISCORD_COMMANDS_ENABLED: 'false' }, { DISCORD_BOT_TOKEN: undefined }])('fails closed for incomplete settings %j', async (settings) => {
    const { ack } = await execute(command(), { ...bindings, ...settings })
    expect(ack.type).toBe(4); expect(calls).toEqual([]); expect(await store.getRevision()).toBe(0)
  })
  it.each([null, '3', 2, 99])('rejects mismatched select component type %j', async (component_type) => {
    const { reply } = await execute(); const before = await store.loadSnapshot()
    await execute(command({ type: 3, data: { custom_id: component(reply).custom_id, component_type, values: ['en_us'] } }))
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it.each(['select', 'apply'])('binds the %s session to its actor and channel', async (action) => {
    const { reply } = await execute(); const before = await store.loadSnapshot()
    for (const overrides of [{ member: { permissions: '32', user: { id: OTHER } } }, { channel_id: SECOND }]) {
      const result = await execute(action === 'select' ? select(reply, ['en_us'], overrides) : apply(reply, overrides))
      expect(result.reply.components).toEqual([])
    }
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it('checks the REST guild and parent against the signed target and session', async () => {
    const { reply } = await execute(); const before = await store.loadSnapshot()
    channelOverride = { guild_id: OTHER }
    await execute(select(reply, ['en_us'])); expect(await store.loadSnapshot()).toEqual(before)
  })
  it.each(['select', 'apply'])('rejects expired or stale %s sessions', async (action) => {
    const { reply } = await execute()
    await env.DB.prepare('UPDATE discord_language_sessions SET expires_at = 0').run()
    const before = await store.loadSnapshot()
    await execute(action === 'select' ? select(reply, ['en_us']) : apply(reply))
    expect(await store.loadSnapshot()).toEqual(before)
    const fresh = await execute(); await store.setFlags(CHANNEL, { eewAlert: true })
    const changed = await store.loadSnapshot()
    await execute(action === 'select' ? select(fresh.reply, ['en_us']) : apply(fresh.reply))
    expect(await store.loadSnapshot()).toEqual(changed)
  })
  it('invalidates both old controls after selecting a language', async () => {
    const { reply } = await execute(); await execute(select(reply, ['en_us']))
    const before = await store.loadSnapshot()
    await execute(select(reply, ['zh_tw'])); await execute(apply(reply))
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it('rejects malformed, unknown and cross-command component sessions', async () => {
    const { reply } = await execute(); const before = await store.loadSnapshot()
    const old = await state.createSession(ACTOR, target, before.revision, 'setup')
    for (const id of ['eewlang:' + 'a'.repeat(32) + ':s', 'eewlang:' + old + ':s', component(reply).custom_id + ':extra',
      'eewlang:../other:s', 'eewlang:' + 'a'.repeat(120) + ':s']) {
      await execute(command({ type: 3, data: { custom_id: id, component_type: 3, values: ['en_us'] } }))
    }
    await execute(command({ type: 3, data: { custom_id: 'eew:' + component(reply).custom_id.split(':')[1] + ':b', component_type: 3, values: ['tsunami'] } }))
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it('does not trust arbitrary body IDs or button language values', async () => {
    await seedGuild(); const { reply } = await execute({ ...command(), targetId: OTHER, guildId: OTHER } as Interaction)
    const result = await execute({ ...apply(reply), targetId: OTHER, guildId: OTHER, language: 'ko_kp' } as Interaction)
    expect(result.reply.content).toContain('English, US')
    expect((await store.getDestination(OTHER))?.lang).toBe('zh_tw')
  })
  it('never logs token-bearing input, underlying failures or snapshots', async () => {
    const logs = ['log', 'info', 'warn', 'error'].map((method) => vi.spyOn(console, method as 'log').mockImplementation(() => {}))
    await store.insertDestinationIfAbsent(FULL)
    const { reply } = await execute()
    const result = await execute(select(reply, [URL]))
    expect(JSON.stringify([result.ack, result.reply, ...logs.map((l) => l.mock.calls)])).not.toContain(SECRET)
    expect(JSON.stringify([...replies.values(), ...logs.map((l) => l.mock.calls)])).not.toContain(BOT)
    expect(logs.every((l) => l.mock.calls.length === 0)).toBe(true)
  })
})

describe('atomic SQL session guards', () => {
  it.each(['actor', 'parent', 'thread', 'guild', 'language', 'revision', 'expiry', 'source-language', 'source-missing'])
    ('rejects a mismatched %s inside the actual mutation statement', async (mismatch) => {
      await seedGuild(); const session = await guard()
      let verified = target, candidate = session
      if (mismatch === 'actor') candidate = { ...session, actorId: OTHER }
      if (mismatch === 'parent') verified = { ...target, channelId: SECOND }
      if (mismatch === 'thread') verified = { ...target, threadId: CHANNEL }
      if (mismatch === 'guild') verified = { ...target, guildId: OTHER }
      if (mismatch === 'language') candidate = { ...session, language: 'zh_tw' }
      if (mismatch === 'revision') candidate = { ...session, revision: session.revision - 1 }
      if (mismatch === 'expiry') await env.DB.prepare('UPDATE discord_language_sessions SET expires_at = 0').run()
      if (mismatch === 'source-language') await env.DB.prepare('UPDATE destinations SET lang = ? WHERE target_id = ?').bind('ko_kp', CHANNEL).run()
      if (mismatch === 'source-missing') await env.DB.prepare('DELETE FROM destinations WHERE target_id = ?').bind(CHANNEL).run()
      const before = await store.loadSnapshot()
      expect(await store.changeLanguageFromSession(verified, candidate, candidate.language as LanguageCode, 'guild')).toBe(0)
      expect(await store.loadSnapshot()).toEqual(before)
    })
  it('does not advance revision for a guild with zero destinations', async () => {
    const session = await guard()
    expect(await store.changeLanguageFromSession(target, session, 'en_us', 'guild')).toBe(0)
    expect(await store.getRevision()).toBe(0)
  })
  it('enforces supported values and the selected bulk language at the storage boundary', async () => {
    await store.insertDestinationIfAbsent(FULL); const session = await guard(); const before = await store.loadSnapshot()
    await expect(store.changeLanguageFromSession(target, session, 'unsupported' as LanguageCode, 'target')).rejects.toThrow('Invalid language mutation')
    await expect(store.changeLanguageFromSession(target, session, 'zh_tw', 'guild')).rejects.toThrow('Invalid language mutation')
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it('checks expiry even if it changes after the handler read the session', async () => {
    await seedGuild(); const { reply } = await execute()
    const original = D1DestinationStore.prototype.changeLanguageFromSession
    vi.spyOn(D1DestinationStore.prototype, 'changeLanguageFromSession').mockImplementation(async function(this: D1DestinationStore, t, s, l, scope) {
      await env.DB.prepare('UPDATE discord_language_sessions SET expires_at = 0').run()
      return original.call(this, t, s, l, scope)
    })
    const before = await store.loadSnapshot(); await execute(apply(reply))
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it('preserves setup/unregister session rows and constraints', async () => {
    const setup = await state.createSession(ACTOR, target, 0, 'setup')
    const unregister = await state.createSession(ACTOR, target, 0, 'unregister')
    await execute()
    expect((await state.session(setup))?.kind).toBe('setup')
    expect((await state.session(unregister))?.kind).toBe('unregister')
    await expect(env.DB.prepare(`UPDATE discord_sessions SET kind = 'lang' WHERE id = ?`).bind(setup).run()).rejects.toThrow()
  })
})
