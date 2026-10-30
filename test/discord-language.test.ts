import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import { ACTOR, CHANNEL, command, component, DiscordMock, execute, GUILD, inThread, THREAD } from './support/discord'
import { resetDb, revision, seedDestination } from './support/fixtures'

const store = new D1DestinationStore(env.DB)
const OTHER_GUILD = '2234567890123456789'
let mock: DiscordMock

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
beforeEach(async () => {
  await resetDb(env.DB)
  mock = new DiscordMock().install()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/lang', () => {
  it('registers the channel with defaults and shows the menu in its language', async () => {
    const { ack, reply } = await execute(command('lang'), mock)
    expect(ack).toMatchObject({ type: 5, data: { flags: 64 } })
    expect(await store.getDestination(CHANNEL)).toMatchObject({ lang: 'ja_jp', webhook: null })
    expect(reply?.content).toBe('日本語')
    expect(reply?.components?.map((r) => r.components[0]?.custom_id)).toEqual(['eewlang:s', 'eewlang:a'])
    expect(mock.requests).toEqual([])
  })

  it('registers a thread under its parent', async () => {
    await execute(command('lang', inThread), mock)
    expect(await store.getDestination(THREAD)).toMatchObject({ channelId: CHANNEL, threadId: THREAD })
  })

  it('sets the language of the channel and answers in it', async () => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD })
    const { ack, reply } = await execute(component('eewlang:s', ['en_us']), mock)
    expect(ack.type).toBe(6)
    expect((await store.getDestination(CHANNEL))?.lang).toBe('en_us')
    expect(reply?.content).toContain('English')
    expect(reply?.components?.[0]?.components[0]?.options?.find((o) => o.default)?.value).toBe('en_us')
  })

  it('applies the channel language to every destination of the guild only', async () => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'zh_tw' })
    await seedDestination(env.DB, { targetId: THREAD, channelId: CHANNEL, threadId: THREAD, guildId: GUILD })
    await seedDestination(env.DB, { targetId: '1234567890123456799', guildId: OTHER_GUILD })
    const { reply } = await execute(component('eewlang:a'), mock)
    expect((await store.getDestination(THREAD))?.lang).toBe('zh_tw')
    expect((await store.getDestination('1234567890123456799'))?.lang).toBe('ja_jp')
    expect(reply?.content).toContain('2')
  })

  it.each([[['xx_yy']], [['en_us', 'ja_jp']], [[]]])('rejects invalid selections %j', async (values) => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD })
    const before = await revision(env.DB)
    const { reply } = await execute(component('eewlang:s', values), mock)
    expect(reply?.content).toContain('1つだけ')
    expect(await revision(env.DB)).toBe(before)
  })

  it('reports a stale menu when the channel is no longer registered', async () => {
    const { reply } = await execute(component('eewlang:s', ['en_us']), mock)
    expect(reply?.content).toContain('/lang')
    expect(await store.getDestination(CHANNEL)).toBeNull()
  })

  it('requires Manage Guild', async () => {
    const { ack } = await execute(command('lang', { member: { permissions: '0', user: { id: ACTOR } } }), mock)
    expect(ack.data?.content).toContain('サーバー管理権限')
    expect(await revision(env.DB)).toBe(0)
  })
})
