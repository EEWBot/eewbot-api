import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import type { Bindings } from '../src/env'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import { DiscordState } from '../src/discord/state'
import type { Interaction, Target } from '../src/discord/types'

const APP = '1234567890123456780'
const GUILD = '1234567890123456789'
const CHANNEL = '1234567890123456790'
const THREAD = '1234567890123456791'
const OTHER = '1234567890123456792'
const ACTOR = '1234567890123456793'
const GUILD_B = '2234567890123456789', CHANNEL_B = '2234567890123456790'
const BOT_TOKEN = 'synthetic-bot-secret'
const HOOK_TOKEN = 'synthetic-webhook-secret'
const BOT_PERMS = (1024n | 2048n | (1n << 29n) | (1n << 38n)).toString()
const target: Target = { targetId: CHANNEL, channelId: CHANNEL, threadId: null, guildId: GUILD }
const threadTarget: Target = { ...target, targetId: THREAD, threadId: THREAD }
const store = new D1DestinationStore(env.DB)
type Hook = { id: string; token?: string; type: number; channel_id: string; guild_id: string; user: { id: string } }
type Menu = { custom_id: string; options: { value: string; default: boolean }[] }
type Reply = { content: string; components: { components: Menu[] }[]; allowed_mentions: { parse: unknown[] } }
let privateKey: CryptoKey
let publicKey: string
let bindings: Bindings
let hooks: Hook[]
let calls: { path: string; method: string; body: unknown }[]
let replies: Map<string, Reply>
let faults: Map<string, number[]>
let rolePermissions: string
let overwrites: { id: string; type: number; allow: string; deny: string }[]
let channelOverride: Record<string, unknown>
let application: string
let ambiguousCreate: boolean
let failAssignment: boolean
let sequence = 0
let beforeCreate: (() => Promise<void>) | undefined

function hook(id = OTHER): Hook {
  return { id, token: HOOK_TOKEN, type: 1, channel_id: CHANNEL, guild_id: GUILD, user: { id: APP } }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  privateKey = keys.privateKey
  publicKey = hex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
})
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM destinations'), env.DB.prepare('DELETE FROM discord_sessions'),
    env.DB.prepare('DELETE FROM discord_interaction_receipts'),
    env.DB.prepare('DELETE FROM discord_setup_locks'), env.DB.prepare('UPDATE config_meta SET channels_revision = 0 WHERE id = 1'),
  ])
  bindings = { DB: env.DB, DISCORD_PUBLIC_KEY: publicKey, DISCORD_COMMANDS_ENABLED: 'true',
    DISCORD_APPLICATION_ID: APP, DISCORD_BOT_TOKEN: BOT_TOKEN }
  hooks = []; calls = []; replies = new Map(); faults = new Map(); rolePermissions = BOT_PERMS
  overwrites = []; channelOverride = {}; application = APP; ambiguousCreate = false; failAssignment = false; beforeCreate = undefined
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://discord.com')
    expect(init?.redirect).toBe('manual')
    expect(init?.signal).toBeDefined()
    const path = url.pathname.replace('/api/v10', '')
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path, method, body })
    const auth = new Headers(init?.headers).get('Authorization')
    expect(auth).toBe(path.endsWith('/messages/@original') ? null : `Bot ${BOT_TOKEN}`)
    const status = faults.get(`${method} ${path}`)?.shift()
    if (status) return new Response(HOOK_TOKEN + BOT_TOKEN, { status })
    if (method === 'PATCH' && path.endsWith('/messages/@original')) {
      replies.set(path.split('/')[3], body)
      return Response.json({ id: ACTOR })
    }
    if (path === '/oauth2/applications/@me') return Response.json({ id: application })
    if (path === `/guilds/${GUILD_B}/members/${APP}`) return Response.json({ user: { id: APP }, roles: [] })
    if (path === `/guilds/${GUILD_B}/roles`) return Response.json([{ id: GUILD_B, permissions: rolePermissions }])
    if (path === `/channels/${CHANNEL_B}`) return Response.json({ id: CHANNEL_B, guild_id: GUILD_B, type: 0, permission_overwrites: [] })
    if (path === `/channels/${CHANNEL_B}/webhooks` && method === 'GET') return Response.json(hooks)
    if (path === `/channels/${CHANNEL_B}/webhooks` && method === 'POST') {
      const created = { ...hook(String(1234567890123456800n + BigInt(hooks.length))), channel_id: CHANNEL_B, guild_id: GUILD_B }
      hooks.push(created)
      return Response.json(created)
    }
    if (path === `/guilds/${GUILD}/members/${APP}`) return Response.json({ user: { id: APP }, roles: [] })
    if (path === `/guilds/${GUILD}/roles`) return Response.json([{ id: GUILD, permissions: rolePermissions }])
    if (path === `/channels/${CHANNEL}`) return Response.json({ id: CHANNEL, guild_id: GUILD, type: 0,
      permission_overwrites: overwrites, ...channelOverride })
    if (path === `/channels/${THREAD}`) return Response.json({ id: THREAD, guild_id: GUILD, type: 11, parent_id: CHANNEL })
    if (path === `/channels/${OTHER}`) return Response.json({ id: OTHER, guild_id: GUILD, type: 0, permission_overwrites: [] })
    if (path === `/channels/${CHANNEL}/webhooks` && method === 'GET') return Response.json(hooks)
    if (path === `/channels/${CHANNEL}/webhooks` && method === 'POST') {
      if (beforeCreate) await beforeCreate()
      const created = hook(String(1234567890123456800n + BigInt(hooks.length)))
      hooks.push(created)
      if (ambiguousCreate) throw new Error(`timeout ${HOOK_TOKEN}`)
      if (failAssignment) await env.DB.prepare(`CREATE TRIGGER fail_webhook BEFORE UPDATE OF webhook_url ON destinations
        BEGIN SELECT RAISE(ABORT, 'synthetic-webhook-secret'); END`).run()
      return Response.json(created)
    }
    if (path.startsWith('/webhooks/') && method === 'DELETE') {
      hooks = hooks.filter((h) => h.id !== path.split('/')[2])
      return new Response(null, { status: 204 })
    }
    throw new Error('Unexpected mock REST request')
  }))
})
afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS fail_webhook').run()
  await env.DB.prepare('DROP TRIGGER IF EXISTS fail_revision').run()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function hex(bytes: Uint8Array) { return Array.from(bytes).map((v) => v.toString(16).padStart(2, '0')).join('') }
function interaction(name = 'setup', overrides: Partial<Interaction> = {}): Interaction {
  sequence++
  return { id: String(1234567890123460000n + BigInt(sequence)), application_id: APP, guild_id: GUILD, channel_id: CHANNEL,
    context: 0, authorizing_integration_owners: { '0': GUILD }, app_permissions: BOT_PERMS,
    member: { permissions: '32', user: { id: ACTOR } }, type: 2, token: `synthetic-interaction-${sequence}`, data: { name }, ...overrides }
}
async function start(payload: Interaction, settings = bindings, invalidSignature = false) {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = hex(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + body))))
  const ctx = createExecutionContext()
  const response = await app.fetch(new Request('https://local/interactions', { method: 'POST', body,
    headers: { 'X-Signature-Ed25519': invalidSignature ? '0'.repeat(128) : signature, 'X-Signature-Timestamp': timestamp } }), settings, ctx)
  return { response, ctx }
}
async function execute(payload = interaction(), settings = bindings) {
  const { response, ctx } = await start(payload, settings)
  const ack = await response.json() as { type: number; data: { flags: number; content: string } }
  await waitOnExecutionContext(ctx)
  return { ack, reply: replies.get(payload.token!)! }
}
function menu(reply: Reply, index = 0): Menu { return reply.components[index].components[0] }
function selection(reply: Reply, index: number, values: string[], overrides: Partial<Interaction> = {}) {
  return interaction('setup', { type: 3, data: { custom_id: menu(reply, index).custom_id, component_type: 3, values }, ...overrides })
}
function button(reply: Reply, confirm = true, overrides: Partial<Interaction> = {}) {
  return interaction('unregister', { type: 3, data: { custom_id: menu(reply, confirm ? 0 : 1).custom_id, component_type: 2 }, ...overrides })
}
function createdCount() { return calls.filter((c) => c.method === 'POST').length }
async function internal(path: string) {
  const ctx = createExecutionContext()
  Object.defineProperty(ctx, 'access', { value: { aud: 'synthetic-aud' } })
  return app.fetch(new Request(`https://local/internal/v1/config/${path}`), { DB: env.DB, ACCESS_AUD: 'synthetic-aud' }, ctx)
}

describe('signed settings authorization', () => {
  const guildB = { guild_id: GUILD_B, channel_id: CHANNEL_B, authorizing_integration_owners: { '0': GUILD_B } }
  it('registers independent destinations and webhooks in two Guild Installs without a fixed Guild binding', async () => {
    await execute()
    const a = await store.getDestination(CHANNEL)
    await execute(interaction('setup', guildB))
    const b = await store.getDestination(CHANNEL_B)
    expect(a?.guildId).toBe(GUILD); expect(b?.guildId).toBe(GUILD_B)
    expect(b?.webhookId).not.toBe(a?.webhookId)
    expect(await store.getDestination(CHANNEL)).toEqual(a)
    expect(hooks).toHaveLength(2)
  })
  it.each(['setup', 'unregister', 'lang'])('rejects ordinary members in both guilds for /%s', async name => {
    for (const guild of [{}, guildB]) {
      const { ack } = await execute(interaction(name, { ...guild, member: { permissions: '0', user: { id: ACTOR } } }))
      expect(ack.data.content).toContain('サーバー管理権限')
    }
    expect(calls).toEqual([]); expect(await store.getRevision()).toBe(0)
  })
  it.each(['8', '32'])('accepts management permission %s in the second guild', async p => {
    const { ack, reply } = await execute(interaction('setup', { ...guildB, member: { permissions: p, user: { id: ACTOR } } }))
    expect(ack.type).toBe(5); expect(reply.components).toHaveLength(3)
  })
  it('rejects another guild using an existing setup or unregister session', async () => {
    for (const name of ['setup', 'unregister']) {
      const { reply } = await execute(interaction(name)), before = await store.loadSnapshot()
      calls = []
      const forged = name === 'setup' ? selection(reply, 0, ['tsunami'], guildB) : button(reply, true, guildB)
      const result = await execute(forged)
      expect(result.reply.components).toEqual([])
      expect(calls.every(c => c.method === 'PATCH')).toBe(true)
      expect(await store.loadSnapshot()).toEqual(before)
    }
  })
  it('rechecks revoked management permissions for setup selects and unregister buttons in both guilds', async () => {
    for (const guild of [{}, guildB]) for (const name of ['setup', 'unregister']) {
      const { reply } = await execute(interaction(name, guild)), before = await store.loadSnapshot()
      calls = []
      const overrides = { ...guild, member: { permissions: '0', user: { id: ACTOR } } }
      const action = name === 'setup' ? selection(reply, 0, ['tsunami'], overrides) : button(reply, true, overrides)
      expect((await execute(action)).ack.data.content).toContain('サーバー管理権限')
      expect(calls).toEqual([]); expect(await store.loadSnapshot()).toEqual(before)
    }
  })
  it('rejects a foreign D1 destination even when REST identifies the current guild', async () => {
    await execute(); const before = await store.loadSnapshot()
    channelOverride = { guild_id: GUILD_B }
    const { reply } = await execute(interaction('setup', { ...guildB, channel_id: CHANNEL }))
    expect(reply.components).toEqual([]); expect(await store.loadSnapshot()).toEqual(before)
  })
  it('does not touch D1 or Discord before signature verification', async () => {
    const read = vi.fn(() => env.DB)
    const { response, ctx } = await start(interaction(), { ...bindings, get DB() { return read() } }, true)
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(401); expect(read).not.toHaveBeenCalled(); expect(calls).toEqual([])
  })
  it.each([
    { application_id: OTHER }, { guild_id: OTHER }, { guild_id: undefined, member: undefined, context: 1 },
    { context: 2 }, { authorizing_integration_owners: { '1': ACTOR } },
    { authorizing_integration_owners: { '0': GUILD, '1': ACTOR } },
    { member: { permissions: '0', user: { id: ACTOR } } },
    { member: { permissions: '-1', user: { id: ACTOR } } },
    { member: { permissions: 'not-a-number', user: { id: ACTOR } } },
    { data: { name: 'setup', options: [{ name: 'channel', value: OTHER }] } },
  ] as Partial<Interaction>[])('rejects unsupported context before any storage or REST work: %j', async (overrides) => {
    const read = vi.fn(() => env.DB)
    const { ack } = await execute(interaction('setup', overrides), { ...bindings, get DB() { return read() } })
    expect(ack.type).toBe(4); expect(ack.data.flags).toBe(64)
    expect(read).not.toHaveBeenCalled(); expect(calls).toEqual([])
  })
  it.each(['DISCORD_COMMANDS_ENABLED', 'DISCORD_APPLICATION_ID', 'DISCORD_BOT_TOKEN'] as const)
    ('fails closed without %s', async (key) => {
      const { ack } = await execute(interaction(), { ...bindings, [key]: undefined })
      expect(ack.type).toBe(4); expect(calls).toEqual([]); expect(await store.getRevision()).toBe(0)
    })
  it.each(['8', '32', String((1n << 60n) | 32n)])('accepts admin/manage-guild with BigInt permissions %s', async (p) => {
    const { ack, reply } = await execute(interaction('setup', { member: { permissions: p, user: { id: ACTOR } } }))
    expect(ack).toMatchObject({ type: 5, data: { flags: 64 } }); expect(reply.components).toHaveLength(3)
  })
  it('requires the configured bot to belong to the test application', async () => {
    application = OTHER
    const { reply } = await execute()
    expect(reply.content).toContain('一致'); expect(await store.getRevision()).toBe(0); expect(createdCount()).toBe(0)
  })
  it('validates channel and guild information from Discord REST', async () => {
    channelOverride = { guild_id: OTHER }
    const { reply } = await execute()
    expect(reply.content).toContain('確認'); expect(await store.getRevision()).toBe(0)
  })
  it.each([2, 4, 13, 15, 16])('rejects unsupported direct channel type %s', async (type) => {
    channelOverride = { type }
    const { reply } = await execute()
    expect(reply.components).toEqual([]); expect(await store.getRevision()).toBe(0)
  })
  it('rejects a thread when the parent belongs to another guild', async () => {
    channelOverride = { guild_id: OTHER }
    await execute(interaction('setup', { channel_id: THREAD }))
    expect(await store.getRevision()).toBe(0)
  })
  it('fails safely when D1 is not configured', async () => {
    const { reply } = await execute(interaction(), { ...bindings, DB: undefined })
    expect(reply.content).toContain('ストレージ'); expect(createdCount()).toBe(0)
  })
  it('ignores extraneous body target IDs and only registers the verified current channel', async () => {
    await execute({ ...interaction(), targetId: OTHER, channelId: OTHER } as Interaction)
    expect(await store.destinationExists(CHANNEL)).toBe(true); expect(await store.destinationExists(OTHER)).toBe(false)
  })
})

describe('setup components and revision contract', () => {
  it('registers Java defaults, returns current menu values, and keeps tokens private', async () => {
    const { ack, reply } = await execute()
    expect(ack.type).toBe(5)
    expect(await store.getDestination(CHANNEL)).toMatchObject({ ...target, eewAlert: false, eewPrediction: false,
      eewDecimation: false, quakeInfo: false, tsunami: false, minIntensity: 1, lang: 'ja_jp' })
    expect(menu(reply).options.every((o) => !o.default)).toBe(true)
    expect(menu(reply, 2).options.filter((o) => o.default).map((o) => o.value)).toEqual(['1'])
    for (const r of replies.values()) {
      expect(r.allowed_mentions).toEqual({ parse: [] })
      expect(JSON.stringify(r)).not.toContain(HOOK_TOKEN); expect(JSON.stringify(r)).not.toContain(BOT_TOKEN)
      for (const row of r.components) expect(row.components[0].custom_id.length).toBeLessThanOrEqual(100)
    }
  })
  it('does not overwrite existing flags or advance revision for duplicate setup', async () => {
    await execute(); await store.setFlags(CHANNEL, { tsunami: true, eewDecimation: true })
    await store.setMinIntensity(CHANNEL, 9)
    const revision = await store.getRevision()
    const { reply } = await execute()
    expect(await store.getRevision()).toBe(revision); expect(createdCount()).toBe(1)
    expect(menu(reply).options.find((o) => o.value === 'tsunami')?.default).toBe(true)
    expect(menu(reply, 1).options[0].default).toBe(true)
    expect(menu(reply, 2).options.find((o) => o.value === '9')?.default).toBe(true)
  })
  it('does not replay a signed setup after the target was unregistered', async () => {
    const original = interaction()
    await execute(original)
    await store.removeDestination(CHANNEL)
    const before = await store.loadSnapshot(); calls = []
    await execute(original)
    expect(await store.loadSnapshot()).toEqual(before); expect(calls).toEqual([])
  })
  it('updates all base flags together, clears unselected flags, preserves modifier and increments once', async () => {
    await execute(); await store.setFlags(CHANNEL, { eewAlert: true, eewPrediction: true, quakeInfo: true, tsunami: true, eewDecimation: true })
    const { reply } = await execute(); const revision = await store.getRevision()
    await execute(selection(reply, 0, ['tsunami']))
    expect(await store.getDestination(CHANNEL)).toMatchObject({ eewAlert: false, eewPrediction: false, quakeInfo: false, tsunami: true, eewDecimation: true })
    expect(await store.getRevision()).toBe(revision + 1)
  })
  it('updates only the modifier group and accepts empty selections in both groups', async () => {
    let { reply } = await execute()
    ;({ reply } = await execute(selection(reply, 0, ['quakeInfo', 'eewAlert'])))
    ;({ reply } = await execute(selection(reply, 1, ['eewDecimation'])))
    expect(await store.getDestination(CHANNEL)).toMatchObject({ quakeInfo: true, eewAlert: true, eewDecimation: true })
    ;({ reply } = await execute(selection(reply, 0, [])))
    expect(await store.getDestination(CHANNEL)).toMatchObject({ quakeInfo: false, eewAlert: false, eewDecimation: true })
    await execute(selection(reply, 1, []))
    expect(await store.getDestination(CHANNEL)).toMatchObject({ eewAlert: false, eewPrediction: false, quakeInfo: false, tsunami: false, eewDecimation: false })
  })
  it.each(Array.from({ length: 10 }, (_, code) => code))('persists Java seismic intensity code %s', async (code) => {
    const { reply } = await execute()
    await execute(selection(reply, 2, [String(code)]))
    expect((await store.getDestination(CHANNEL))?.minIntensity).toBe(code)
  })
  it.each([[], ['10'], ['-1'], ['5弱'], ['5-'], ['1', '2'], ['1.0'], ['01']].map((values) => ({ values })))('rejects invalid intensity $values', async ({ values }) => {
    const { reply } = await execute(); const before = await store.loadSnapshot()
    await execute(selection(reply, 2, values)); expect(await store.loadSnapshot()).toEqual(before)
  })
  it.each([['eewDecimation'], ['channelId'], ['tsunami', 'tsunami']])('rejects invalid base selections %j', async (...values) => {
    const { reply } = await execute(); const before = await store.loadSnapshot()
    await execute(selection(reply, 0, values)); expect(await store.loadSnapshot()).toEqual(before)
  })
  it('rechecks permissions after opening menus', async () => {
    const { reply } = await execute(); const before = await store.loadSnapshot(); calls = []
    const { ack } = await execute(selection(reply, 0, ['tsunami'], { member: { permissions: '0', user: { id: ACTOR } } }))
    expect(ack.type).toBe(4); expect(calls).toEqual([]); expect(await store.loadSnapshot()).toEqual(before)
  })
  it('refreshes the existing ephemeral component message in place', async () => {
    const { reply } = await execute()
    const result = await execute(selection(reply, 0, ['tsunami']))
    expect(result.ack).toEqual({ type: 6 })
    expect(result.reply.content).toContain('保存しました')
    expect(menu(result.reply).custom_id).not.toBe(menu(reply).custom_id)
  })
  it('rejects cross-kind or malformed component IDs without a mutation', async () => {
    const { reply } = await execute(); const before = await store.loadSnapshot()
    for (const custom_id of [menu(reply).custom_id.replace(/:b$/, ':c'), 'eew:' + OTHER + ':b', menu(reply).custom_id + ':extra']) {
      await execute(interaction('setup', { type: 3, data: { custom_id, component_type: 2 } }))
    }
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it.each([{ member: { permissions: '32', user: { id: OTHER } } }, { channel_id: OTHER }])
    ('binds components to their actor and original channel: %j', async (overrides) => {
      const { reply } = await execute(); const before = await store.loadSnapshot()
      const result = await execute(selection(reply, 0, ['tsunami'], overrides))
      expect(result.reply.content).toContain('再度'); expect(await store.loadSnapshot()).toEqual(before)
    })
  it('rejects expired and unknown component sessions', async () => {
    const { reply } = await execute()
    await env.DB.prepare('UPDATE discord_sessions SET expires_at = 0').run()
    const before = await store.loadSnapshot()
    await execute(selection(reply, 0, ['tsunami']))
    await execute(interaction('setup', { type: 3, data: { custom_id: 'eew:' + 'a'.repeat(32) + ':b', component_type: 3, values: ['tsunami'] } }))
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it('detects stale revisions and replayed selects even for same-value updates', async () => {
    const { reply } = await execute()
    await store.setFlags(CHANNEL, { eewAlert: false })
    const before = await store.loadSnapshot()
    expect((await execute(selection(reply, 0, ['tsunami']))).reply.content).toContain('再度')
    expect(await store.loadSnapshot()).toEqual(before)
    const fresh = await execute(); await execute(selection(fresh.reply, 0, []))
    const revision = await store.getRevision()
    await execute(selection(fresh.reply, 0, ['tsunami']))
    expect(await store.getRevision()).toBe(revision)
  })
  it('allows only one of concurrent component updates to commit', async () => {
    const { reply } = await execute(); const revision = await store.getRevision()
    const results = await Promise.all([execute(selection(reply, 0, ['tsunami'])), execute(selection(reply, 0, ['quakeInfo']))])
    expect(await store.getRevision()).toBe(revision + 1)
    expect(results.filter((r) => r.reply.content.includes('保存しました'))).toHaveLength(1)
    expect(results.filter((r) => r.reply.content.includes('再度'))).toHaveLength(1)
  })
  it('publishes the committed state through the unchanged internal revision and snapshot endpoints', async () => {
    const { reply } = await execute()
    await execute(selection(reply, 0, ['eewAlert', 'quakeInfo']))
    const revision = await store.getRevision()
    expect(await (await internal('revision')).json()).toEqual({ revision })
    expect(await (await internal('snapshot')).json()).toEqual(await store.loadSnapshot())
    expect((await store.loadSnapshot()).destinations[0]).toMatchObject({ eewAlert: true, quakeInfo: true })
  })
})

describe('unregister current target only', () => {
  it('reports unregistered targets without incrementing revision', async () => {
    const { reply } = await execute(interaction('unregister'))
    expect(reply.content).toContain('登録されていません'); expect(await store.getRevision()).toBe(0)
  })
  it('cancel preserves the full config snapshot and revision', async () => {
    await execute(); const { reply } = await execute(interaction('unregister')); const before = await store.loadSnapshot()
    const receipts = await env.DB.prepare('SELECT * FROM discord_interaction_receipts ORDER BY id').all()
    expect((await execute(button(reply, false))).reply.content).toContain('キャンセル')
    expect(await store.loadSnapshot()).toEqual(before)
    expect((await env.DB.prepare('SELECT * FROM discord_interaction_receipts ORDER BY id').all()).results).toEqual(receipts.results)
  })
  it('confirm deletes the parent only, leaves its thread, and advances revision once', async () => {
    await execute(); await execute(interaction('setup', { channel_id: THREAD }))
    const { reply } = await execute(interaction('unregister')); const revision = await store.getRevision()
    await execute(button(reply))
    expect(await store.destinationExists(CHANNEL)).toBe(false); expect(await store.destinationExists(THREAD)).toBe(true)
    expect(await store.getRevision()).toBe(revision + 1)
    expect((await (await internal('snapshot')).json() as { destinations: unknown[] }).destinations).toHaveLength(1)
  })
  it('unregisters a thread independently', async () => {
    await execute(); await execute(interaction('setup', { channel_id: THREAD }))
    const { reply } = await execute(interaction('unregister', { channel_id: THREAD }))
    await execute(button(reply, true, { channel_id: THREAD }))
    expect(await store.destinationExists(THREAD)).toBe(false); expect(await store.destinationExists(CHANNEL)).toBe(true)
  })
  it.each([true, false])('rechecks permissions on confirm/cancel: %s', async (confirm) => {
    await execute(); const { reply } = await execute(interaction('unregister')); const before = await store.loadSnapshot()
    const result = await execute(button(reply, confirm, { member: { permissions: '0', user: { id: ACTOR } } }))
    expect(result.ack.type).toBe(4); expect(await store.loadSnapshot()).toEqual(before)
  })
  it('does not delete a changed/re-registered destination using an old confirmation', async () => {
    await execute(); const { reply } = await execute(interaction('unregister'))
    await store.removeDestination(CHANNEL); await execute()
    const before = await store.loadSnapshot()
    await execute(button(reply)); expect(await store.loadSnapshot()).toEqual(before)
  })
  it('refuses confirmation by another manager or in another channel', async () => {
    await execute(); const { reply } = await execute(interaction('unregister')); const before = await store.loadSnapshot()
    await execute(button(reply, true, { member: { permissions: '32', user: { id: OTHER } } }))
    await execute(button(reply, true, { channel_id: OTHER }))
    expect(await store.loadSnapshot()).toEqual(before)
  })
  it('does not advance the revision when the target disappeared before confirm', async () => {
    await execute(); const { reply } = await execute(interaction('unregister'))
    await store.removeDestination(CHANNEL); const revision = await store.getRevision()
    await execute(button(reply)); expect(await store.getRevision()).toBe(revision)
  })
})

describe('webhook REST integration and concurrency', () => {
  it('registers without a webhook and warns when MANAGE_WEBHOOKS is missing', async () => {
    rolePermissions = String(1024n | 2048n)
    const { reply } = await execute()
    expect(reply.content).toContain('警告'); expect((await store.getDestination(CHANNEL))?.webhookUrl).toBeNull()
    expect(createdCount()).toBe(0); expect(await store.getRevision()).toBe(1)
  })
  it('refuses registration without send permissions, including channel overwrites', async () => {
    overwrites = [{ id: GUILD, type: 0, deny: '2048', allow: '0' }]
    const { reply } = await execute()
    expect(reply.content).toContain('送信権限'); expect(await store.getRevision()).toBe(0); expect(createdCount()).toBe(0)
  })
  it('requires SEND_MESSAGES_IN_THREADS from the signed app permissions', async () => {
    await execute(interaction('setup', { channel_id: THREAD, app_permissions: '3072' }))
    expect(await store.getRevision()).toBe(0)
  })
  it.each(['role', 'overwrite'])('allows thread-only sending without parent SEND_MESSAGES via %s permissions', async (source) => {
    const threadPermissions = String(BigInt(BOT_PERMS) & ~2048n)
    if (source === 'role') rolePermissions = threadPermissions
    else overwrites = [{ id: GUILD, type: 0, deny: '2048', allow: '0' }]
    const { ack, reply } = await execute(interaction('setup', { channel_id: THREAD, app_permissions: threadPermissions }))
    expect(ack.type).toBe(5); expect(reply.components).toHaveLength(3)
    expect(await store.getDestination(THREAD)).toMatchObject(threadTarget)
    expect((await store.getDestination(THREAD))?.webhookUrl).toContain(`?thread_id=${THREAD}`)
    expect(await store.destinationExists(CHANNEL)).toBe(false)
    expect(createdCount()).toBe(1); expect(await store.getRevision()).toBe(2)
  })
  it.each([CHANNEL, THREAD].flatMap((channelId) => ['REST', 'app_permissions'].flatMap((source) =>
    ['send', 'view'].map((missing) => ({ channelId, source, missing })))))
    ('rejects missing $missing permission in $source for target $channelId', async ({ channelId, source, missing }) => {
      const bit = missing === 'view' ? 1024n : channelId === THREAD ? 1n << 38n : 2048n
      const incomplete = String(BigInt(BOT_PERMS) & ~bit)
      if (source === 'REST') rolePermissions = incomplete
      const { reply } = await execute(interaction('setup', { channel_id: channelId,
        app_permissions: source === 'app_permissions' ? incomplete : BOT_PERMS }))
      expect(reply.content).toContain('送信権限'); expect(reply.components).toEqual([])
      expect(await store.loadSnapshot()).toEqual({ revision: 0, destinations: [] })
      expect(createdCount()).toBe(0)
    })
  it('honors administrator bypass of channel permission overwrites', async () => {
    rolePermissions = '8'; overwrites = [{ id: GUILD, type: 0, deny: BOT_PERMS, allow: '0' }]
    const { reply } = await execute()
    expect(reply.components).toHaveLength(3)
  })
  it('does not reuse another bot webhook', async () => {
    hooks.push({ ...hook(), user: { id: OTHER } })
    await execute()
    expect(createdCount()).toBe(1); expect((await store.getDestination(CHANNEL))?.webhookId).not.toBe(OTHER)
  })
  it('creates a new webhook and reuses a bot-created unassigned existing webhook', async () => {
    hooks.push(hook())
    await execute()
    expect((await store.getDestination(CHANNEL))?.webhookId).toBe(OTHER); expect(createdCount()).toBe(0)
  })
  it('recreates a deleted webhook rather than trusting its stored URL', async () => {
    await store.insertDestinationIfAbsent({ ...target, webhookUrl: `https://discord.com/api/webhooks/${OTHER}/${HOOK_TOKEN}` })
    await execute()
    expect((await store.getDestination(CHANNEL))?.webhookId).not.toBe(OTHER); expect(createdCount()).toBe(1)
  })
  it('keeps parent and thread webhooks exclusive and preserves thread_id in saved URL', async () => {
    await execute(); await execute(interaction('setup', { channel_id: THREAD }))
    const parent = await store.getDestination(CHANNEL); const thread = await store.getDestination(THREAD)
    expect(thread).toMatchObject(threadTarget); expect(thread?.webhookId).not.toBe(parent?.webhookId)
    expect(thread?.webhookUrl).toContain(`?thread_id=${THREAD}`)
    expect(parent?.webhookUrl).not.toContain('thread_id'); expect(createdCount()).toBe(2)
  })
  it('serializes concurrent setup to prevent duplicate webhook creation', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let entered!: () => void
    const created = new Promise<void>((r) => { entered = r })
    beforeCreate = async () => { entered(); await gate }
    const first = await start(interaction())
    expect(await first.response.json()).toMatchObject({ type: 5 })
    await created
    const second = await execute()
    expect(second.reply.content).toContain('設定処理中')
    release(); await waitOnExecutionContext(first.ctx)
    await execute()
    expect(createdCount()).toBe(1); expect(hooks).toHaveLength(1)
  })
  it('uses the same parent lock for a concurrently registering thread', async () => {
    const state = new DiscordState(env.DB)
    expect(await state.lock(CHANNEL, 'synthetic-owner')).toBe(true)
    const { reply } = await execute(interaction('setup', { channel_id: THREAD }))
    expect(reply.content).toContain('設定処理中'); expect(await store.destinationExists(THREAD)).toBe(false)
  })
  it.each([403, 404, 429, 500, 503])('handles REST channel failure HTTP %s without modifying D1', async (status) => {
    faults.set(`GET /channels/${CHANNEL}`, [status])
    const { reply } = await execute()
    expect(reply.components).toEqual([]); expect(await store.getRevision()).toBe(0); expect(createdCount()).toBe(0)
    expect(JSON.stringify(reply)).not.toContain(HOOK_TOKEN)
  })
  it.each([403, 404, 429, 500])('does not report setup success after webhook creation HTTP %s', async (status) => {
    faults.set(`POST /channels/${CHANNEL}/webhooks`, [status])
    const { reply } = await execute()
    expect(reply.components).toEqual([]); expect(reply.content).not.toContain('保存しました')
    expect((await store.getDestination(CHANNEL))?.webhookUrl).toBeNull()
  })
  it.each([403, 404, 429, 500])('does not create webhooks after discovery HTTP %s', async (status) => {
    faults.set(`GET /channels/${CHANNEL}/webhooks`, [status])
    const { reply } = await execute()
    expect(reply.components).toEqual([]); expect(createdCount()).toBe(0)
  })
  it('retries a transient response edit without repeating D1 writes or webhook creation', async () => {
    const request = interaction()
    faults.set(`PATCH /webhooks/${APP}/${request.token}/messages/@original`, [429])
    const { reply } = await execute(request)
    expect(reply.components).toHaveLength(3); expect(createdCount()).toBe(1); expect(await store.getRevision()).toBe(2)
  })
  it('aborts stalled REST requests and still edits the ephemeral error response', async () => {
    const mockedFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(`/channels/${CHANNEL}`)) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error(HOOK_TOKEN)))
      })
      return mockedFetch(input, init)
    })
    const { reply } = await execute()
    expect(reply.content).toContain('通信に失敗'); expect(await store.getRevision()).toBe(0)
    expect(JSON.stringify(reply)).not.toContain(HOOK_TOKEN)
  })
  it('retains a cooldown on ambiguous create failure and later reuses the created webhook', async () => {
    ambiguousCreate = true
    await execute(); await execute()
    expect(createdCount()).toBe(1); expect(hooks).toHaveLength(1)
    await env.DB.prepare('UPDATE discord_setup_locks SET expires_at = 0').run()
    ambiguousCreate = false
    await execute()
    expect(createdCount()).toBe(1); expect((await store.getDestination(CHANNEL))?.webhookId).toBe(hooks[0].id)
  })
  it('deletes an orphan when the newly created webhook cannot be saved', async () => {
    failAssignment = true
    const { reply } = await execute()
    expect(reply.components).toEqual([]); expect(hooks).toEqual([])
    expect((await store.getDestination(CHANNEL))?.webhookUrl).toBeNull()
    expect(await store.getRevision()).toBe(1)
  })
  it('logs only sanitized diagnostics when orphan cleanup also fails', async () => {
    const logs = vi.spyOn(console, 'warn').mockImplementation(() => {})
    failAssignment = true
    faults.set('DELETE /webhooks/1234567890123456800', [500])
    const { reply } = await execute()
    expect(logs).toHaveBeenCalled()
    expect(JSON.stringify([logs.mock.calls, reply])).not.toContain(HOOK_TOKEN)
    expect(JSON.stringify([logs.mock.calls, reply])).not.toContain(BOT_TOKEN)
    expect(JSON.stringify([logs.mock.calls, reply])).not.toContain('synthetic-interaction')
  })
  it('does not trust a stored webhook URL as a REST destination', async () => {
    await env.DB.prepare(`INSERT INTO destinations (target_id, channel_id, guild_id, webhook_id, webhook_url)
      VALUES (?, ?, ?, ?, ?)`).bind(CHANNEL, CHANNEL, GUILD, OTHER, 'https://attacker.invalid/secret').run()
    await execute()
    expect(calls.every((c) => !c.path.includes('attacker'))).toBe(true)
    expect((await store.getDestination(CHANNEL))?.webhookUrl).toMatch(/^https:\/\/discord.com\/api\/webhooks\//)
  })
})

describe('atomic D1 compare-and-swap and webhook reservations', () => {
  it('atomically awards a webhook to only one target even without a unique index', async () => {
    const state = new DiscordState(env.DB)
    await store.insertDestinationIfAbsent(target); await store.insertDestinationIfAbsent(threadTarget)
    await state.lock(CHANNEL, 'owner')
    const revision = await store.getRevision()
    const results = await Promise.all([store.changeIfRevision(target, revision, { webhookUrl: `https://discord.com/api/webhooks/${OTHER}/${HOOK_TOKEN}`, lockOwner: 'owner' }),
      store.changeIfRevision(threadTarget, revision, { webhookUrl: `https://discord.com/api/webhooks/${OTHER}/${HOOK_TOKEN}?thread_id=${THREAD}`, lockOwner: 'owner' })])
    expect(results.sort()).toEqual([0, 1])
    const next = await store.getRevision()
    const loser = (await store.getDestination(CHANNEL))?.webhookId ? threadTarget : target
    expect(await store.changeIfRevision(loser, next, { webhookUrl: `https://discord.com/api/webhooks/${OTHER}/${HOOK_TOKEN}`, lockOwner: 'owner' })).toBe(0)
    expect(await store.getRevision()).toBe(next)
  })
  it('does not assign a webhook with an expired or foreign lease', async () => {
    await store.insertDestinationIfAbsent(target)
    const state = new DiscordState(env.DB); await state.lock(CHANNEL, 'owner')
    expect(await store.changeIfRevision(target, 1, { webhookUrl: `https://discord.com/api/webhooks/${OTHER}/${HOOK_TOKEN}`, lockOwner: 'other' })).toBe(0)
    await env.DB.prepare('UPDATE discord_setup_locks SET expires_at = 0').run()
    expect(await store.changeIfRevision(target, 1, { webhookUrl: `https://discord.com/api/webhooks/${OTHER}/${HOOK_TOKEN}`, lockOwner: 'owner' })).toBe(0)
    expect(await store.getRevision()).toBe(1)
  })
  it('checks the session identity and expiry inside the mutation statement', async () => {
    await store.insertDestinationIfAbsent(target)
    const state = new DiscordState(env.DB)
    const id = await state.createSession(ACTOR, target, 1, 'setup')
    expect(await store.changeIfRevision(target, 1, { flags: { tsunami: true } }, { id, actorId: OTHER })).toBe(0)
    await env.DB.prepare('UPDATE discord_sessions SET expires_at = 0').run()
    expect(await store.changeIfRevision(target, 1, { flags: { tsunami: true } }, { id, actorId: ACTOR })).toBe(0)
    expect(await store.getRevision()).toBe(1)
  })
  it('rolls back a multi-flag mutation when revision update fails', async () => {
    const { reply } = await execute()
    await env.DB.prepare(`CREATE TRIGGER fail_revision BEFORE UPDATE ON config_meta
      BEGIN SELECT RAISE(ABORT, 'synthetic-webhook-secret'); END`).run()
    const before = await store.loadSnapshot()
    const result = await execute(selection(reply, 0, ['tsunami', 'eewAlert']))
    expect(result.reply.content).not.toContain('保存しました'); expect(await store.loadSnapshot()).toEqual(before)
  })
  it('keeps legacy shared webhook data readable without introducing a unique constraint', async () => {
    const webhookUrl = `https://discord.com/api/webhooks/${OTHER}/${HOOK_TOKEN}`
    await store.insertDestinationIfAbsent({ ...target, webhookUrl })
    await store.insertDestinationIfAbsent({ ...threadTarget, webhookUrl: `${webhookUrl}?thread_id=${THREAD}` })
    expect((await store.loadSnapshot()).destinations).toHaveLength(2)
    expect(await store.isWebhookExclusiveToTarget(OTHER, CHANNEL)).toBe(false)
  })
})
