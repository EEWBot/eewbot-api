import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test'
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import app from '../src/index'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import type { Bindings } from '../src/env'
import type { Interaction } from '../src/discord/types'
import { helpEmbed } from '../src/discord/info-commands'
import { helpText } from '../src/i18n/help'
import { LANGUAGES } from '../src/i18n/languages'

const APP = '1234567890123456780', GUILD = '1234567890123456781', CHANNEL = '1234567890123456782'
const THREAD = '1234567890123456783', USER = '1234567890123456784'
const store = new D1DestinationStore(env.DB)
let key: CryptoKey, bindings: Bindings
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  key = pair.privateKey
  const publicKey = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))).map(n => n.toString(16).padStart(2, '0')).join('')
  bindings = { DB: env.DB, DISCORD_PUBLIC_KEY: publicKey, DISCORD_COMMANDS_ENABLED: 'true', DISCORD_APPLICATION_ID: APP, DISCORD_TEST_GUILD_ID: GUILD }
})
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM destinations'), env.DB.prepare('UPDATE config_meta SET channels_revision = 0 WHERE id = 1')])
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected REST') }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function command(name: string, overrides: Partial<Interaction> = {}): Interaction {
  return { type: 2, id: USER, application_id: APP, guild_id: GUILD, channel_id: CHANNEL, context: 0,
    authorizing_integration_owners: { '0': GUILD }, token: 'synthetic-token', member: { user: { id: USER }, permissions: '0' }, data: { name }, ...overrides }
}
async function execute(i: Interaction, config = bindings, timestamp = String(Math.floor(Date.now() / 1000)), bad = false) {
  const body = JSON.stringify(i)
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(timestamp + body))))
    .map(n => n.toString(16).padStart(2, '0')).join('')
  const response = await app.fetch(new Request('https://local/interactions', { method: 'POST', body, headers: {
    'X-Signature-Ed25519': bad ? '0'.repeat(128) : signature, 'X-Signature-Timestamp': timestamp,
  } }), config, createExecutionContext())
  return { status: response.status, body: response.status === 200 ? await response.json() as any : null }
}

it('returns public Japanese help for an unregistered channel without writes or REST', async () => {
  const before = await store.loadSnapshot(), result = await execute(command('help'))
  expect(result.body.type).toBe(4); expect(result.body.data.flags).toBeUndefined()
  expect(result.body.data.embeds[0].description).toBe(helpText('ja_jp', 'desc'))
  expect(result.body.data.allowed_mentions).toEqual({ parse: [] })
  expect(await store.loadSnapshot()).toEqual(before); expect(fetch).not.toHaveBeenCalled()
})
it.each(LANGUAGES)('renders $code from D1 without altering destinations or revision', async ({ code }) => {
  await store.insertDestinationIfAbsent({ targetId: CHANNEL, channelId: CHANNEL, guildId: GUILD, lang: code })
  const before = await store.loadSnapshot(), result = await execute(command('help'))
  expect(result.body.data.embeds[0]).toEqual(helpEmbed(code)); expect(await store.loadSnapshot()).toEqual(before)
})
it('uses the thread setting, independently of its parent', async () => {
  await store.insertDestinationIfAbsent({ targetId: CHANNEL, channelId: CHANNEL, guildId: GUILD, lang: 'en_us' })
  await store.insertDestinationIfAbsent({ targetId: THREAD, channelId: CHANNEL, threadId: THREAD, guildId: GUILD, lang: 'ko_kp' })
  const before = await store.loadSnapshot(), result = await execute(command('help', { channel_id: THREAD }))
  expect(result.body.data.embeds[0]).toEqual(helpEmbed('ko_kp')); expect(await store.loadSnapshot()).toEqual(before)
})
it.each(['unknown', 'foreign'])('falls back to Japanese for %s', async (kind) => {
  await store.insertDestinationIfAbsent({ targetId: CHANNEL, channelId: CHANNEL, guildId: kind === 'foreign' ? USER : GUILD, lang: kind === 'foreign' ? 'en_us' : 'legacy' })
  expect((await execute(command('help'))).body.data.embeds[0]).toEqual(helpEmbed('ja_jp'))
})
it('falls back for missing Java keys and lists verified quakeinfo support within limits', () => {
  for (const { code } of LANGUAGES) {
    const embed = helpEmbed(code)
    expect(embed.fields.map(f => f.name).slice(0, 7)).toEqual(['/setup', '/quakeinfo', '/invite', '/testmessage', '/lang', '/unregister', '/help'])
    expect(embed.fields[1].value).toBe(helpText(code, 'quakeinfo')); expect(embed.fields[3].value).toBe(helpText(code, 'testmessage'))
    expect(embed.fields[7].value).toContain('github.com/EEWBot/EEWBot/wiki/'); expect(embed.fields[7].value).toContain('discord.gg/')
    expect(embed.fields[8].value).toContain('eewbot.net/privacy'); expect(embed.fields[8].value).toContain('eewbot.net/terms')
    expect(embed.title.length).toBeLessThanOrEqual(256); expect(embed.description.length).toBeLessThanOrEqual(4096)
    for (const field of embed.fields) { expect(field.name.length).toBeLessThanOrEqual(256); expect(field.value.length).toBeLessThanOrEqual(1024) }
    expect(embed.title.length + embed.description.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0)).toBeLessThanOrEqual(6000)
  }
  expect(helpText('zh_tw', 'legal')).toBe(helpText('ja_jp', 'legal'))
  expect(helpText('ko_kp', 'unregister')).toBe(helpText('ja_jp', 'unregister'))
})
it('handles missing and failing storage with a Japanese response', async () => {
  expect((await execute(command('help'), { ...bindings, DB: undefined })).body.data.embeds[0]).toEqual(helpEmbed('ja_jp'))
  const db = { prepare() { throw new Error('private storage error') } } as unknown as D1Database
  const result = await execute(command('help'), { ...bindings, DB: db })
  expect(result.body.data.embeds[0]).toEqual(helpEmbed('ja_jp')); expect(JSON.stringify(result.body)).not.toContain('private storage error')
})
it('creates a private staging invite with fixed permissions, no D1 or REST', async () => {
  const read = vi.fn(() => env.DB)
  const result = await execute(command('invite'), { ...bindings, get DB() { return read() } })
  expect(result.body.data.flags).toBe(64); expect(result.body.data.content).toContain('EEWBot Dev')
  const url = new URL(result.body.data.content.split(' ').at(-1))
  expect(url.origin).toBe('https://discord.com'); expect(url.pathname).toBe('/oauth2/authorize')
  expect([...url.searchParams.entries()]).toEqual([['client_id', APP], ['permissions', '275414830144'], ['scope', 'bot applications.commands']])
  expect(result.body.data.content).not.toContain('synthetic-token'); expect(read).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
})
it.each(['help', 'invite'])('%s rejects invalid signatures, expired timestamps, context, config, and options', async (name) => {
  expect((await execute(command(name), bindings, undefined, true)).status).toBe(401)
  expect((await execute(command(name), bindings, String(Math.floor(Date.now() / 1000) - 600))).status).toBe(401)
  const variants: Partial<Interaction>[] = [
    { application_id: USER }, { guild_id: USER }, { guild_id: undefined }, { context: 1 },
    { authorizing_integration_owners: { '0': GUILD, '1': USER } }, { authorizing_integration_owners: {} },
    { channel_id: undefined }, { member: undefined }, { token: undefined }, { data: { name, options: [{ name: 'bad' }] } },
    { data: { name, options: null } },
  ]
  for (const variant of variants) expect((await execute(command(name, variant))).body.data.flags).toBe(64)
  expect((await execute(command(name), { ...bindings, DISCORD_COMMANDS_ENABLED: 'false' })).body.data.flags).toBe(64)
  expect(fetch).not.toHaveBeenCalled()
})
it.each(['setup', 'unregister', 'lang'])('%s still rejects users without management permission', async name => {
  expect((await execute(command(name), { ...bindings, DISCORD_BOT_TOKEN: 'synthetic' })).body.data.content).toContain('サーバー管理権限')
})
it('returns Japanese within the response budget if D1 does not finish', async () => {
  const db = { prepare() { return { bind() { return { first() { return new Promise(() => {}) } } } } } } as unknown as D1Database
  const start = Date.now(), result = await execute(command('help'), { ...bindings, DB: db })
  expect(Date.now() - start).toBeLessThan(2800)
  expect(result.body.data.embeds[0]).toEqual(helpEmbed('ja_jp'))
})
