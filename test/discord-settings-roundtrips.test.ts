import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import type { DestinationTarget } from '../src/db/destination-types'
import type { Interaction } from '../src/discord/types'
import { apiText } from '../src/i18n/api'
import { coreText } from '../src/i18n/core'
import { translate } from '../src/i18n/languages'
import { setupReply } from '../src/i18n/settings'
import {
  APP,
  CHANNEL,
  command,
  component,
  DiscordMock,
  DM,
  execute,
  GUILD,
  HOOK_TOKEN,
  inDm,
  inThread,
  THREAD,
} from './support/discord'
import { resetDb, seedDestination } from './support/fixtures'

const store = new D1DestinationStore(env.DB)
const CHANNEL_TARGET: DestinationTarget = { targetId: CHANNEL, guildId: GUILD, channelId: CHANNEL, threadId: null }
const THREAD_TARGET: DestinationTarget = { targetId: THREAD, guildId: GUILD, channelId: CHANNEL, threadId: THREAD }
const contexts: { name: string; context: Partial<Interaction>; target: DestinationTarget }[] = [
  {
    name: 'channel',
    context: {},
    target: CHANNEL_TARGET,
  },
  {
    name: 'thread',
    context: inThread,
    target: THREAD_TARGET,
  },
  { name: 'DM', context: inDm, target: { targetId: DM, guildId: null, channelId: DM, threadId: null } },
]
let mock: DiscordMock

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
beforeEach(async () => {
  await resetDb(env.DB)
  mock = new DiscordMock().install()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(contexts)('$name D1 round trips', ({ context, target }) => {
  it.each([false, true])('opens /setup with one read and one batch (registered=%s)', async (registered) => {
    if (registered) await seedDestination(env.DB, target)
    const reads = vi.spyOn(D1DestinationStore.prototype, 'getDestination')
    const batches = vi.spyOn(env.DB, 'batch')
    const { reply } = await execute(
      command('setup', { ...context, app_permissions: String(1024n | 2048n | (1n << 38n)) }),
      mock,
    )
    expect(reply?.components).toHaveLength(3)
    expect(reads).toHaveBeenCalledExactlyOnceWith(target.targetId)
    expect(batches).toHaveBeenCalledTimes(1)
    expect(mock.requests).toEqual([])
  })

  it.each([false, true])('opens /lang without a read after registration (registered=%s)', async (registered) => {
    if (registered) await seedDestination(env.DB, target)
    const reads = vi.spyOn(D1DestinationStore.prototype, 'getDestination')
    const batches = vi.spyOn(env.DB, 'batch')
    const { reply } = await execute(command('lang', context), mock)
    expect(reply?.components?.[0]?.components[0]?.custom_id).toBe('eewlang:s')
    expect(reads).toHaveBeenCalledExactlyOnceWith(target.targetId)
    expect(batches).toHaveBeenCalledTimes(registered ? 0 : 1)
  })

  it.each([
    { action: 'eew:b', values: ['tsunami'] },
    { action: 'eew:b', values: [] },
    { action: 'eew:i', values: ['4'] },
    { action: 'eewlang:s', values: ['en_us'] },
  ])('applies $action values $values with one read and one batch', async ({ action, values }) => {
    await seedDestination(env.DB, target)
    const reads = vi.spyOn(D1DestinationStore.prototype, 'getDestination')
    const batches = vi.spyOn(env.DB, 'batch')
    const { reply } = await execute(component(action, values, context), mock)
    expect(reply?.components?.length).toBeGreaterThan(0)
    expect(reads).toHaveBeenCalledExactlyOnceWith(target.targetId)
    expect(batches).toHaveBeenCalledTimes(1)
  })
})

it.each([
  { state: 'unassigned', storedToken: null, token: HOOK_TOKEN, expectedBatches: 2 },
  { state: 'unchanged', storedToken: HOOK_TOKEN, token: HOOK_TOKEN, expectedBatches: 1 },
  { state: 'refreshed', storedToken: HOOK_TOKEN, token: `${HOOK_TOKEN}-refreshed`, expectedBatches: 2 },
  { state: 'created', storedToken: null, token: HOOK_TOKEN, expectedBatches: 2 },
])(
  'uses the $state webhook result without another destination read',
  async ({ state, storedToken, token, expectedBatches }) => {
    const hook = { id: '1234567890123456800', token, type: 1, channel_id: CHANNEL, user: { id: APP } }
    if (state !== 'created') {
      await seedDestination(env.DB, {
        ...CHANNEL_TARGET,
        webhook: storedToken ? { id: hook.id, token: storedToken } : null,
      })
    }
    mock.routes.set(`GET /channels/${CHANNEL}/webhooks`, () => Response.json(state === 'created' ? [] : [hook]))
    mock.routes.set(`GET /guilds/${GUILD}/members/${APP}`, () =>
      Response.json({ user: { id: APP, username: 'EEWBot' } }),
    )
    mock.routes.set(`POST /channels/${CHANNEL}/webhooks`, () => Response.json(hook))
    const reads = vi.spyOn(D1DestinationStore.prototype, 'getDestination')
    const batches = vi.spyOn(env.DB, 'batch')
    const { reply } = await execute(command('setup'), mock)
    expect(reply?.content).toBe(setupReply('ja_jp', false))
    expect(reply?.components).toHaveLength(3)
    expect(reads).toHaveBeenCalledExactlyOnceWith(CHANNEL)
    expect(batches).toHaveBeenCalledTimes(expectedBatches)
    expect((await store.getDestination(CHANNEL))?.webhook).toEqual({ id: hook.id, token })
  },
)

it('applies a guild language with one read and one batch, including repeated applies', async () => {
  await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'en_us' })
  await seedDestination(env.DB, THREAD_TARGET)
  const reads = vi.spyOn(D1DestinationStore.prototype, 'getDestination')
  const batches = vi.spyOn(env.DB, 'batch')
  for (const count of [1, 0]) {
    const { reply } = await execute(component('eewlang:a'), mock)
    expect(reply?.content).toContain(translate('en_us', 'count', String(count)))
    expect(reply?.components?.length).toBeGreaterThan(0)
    expect(reads).toHaveBeenCalledExactlyOnceWith(CHANNEL)
    expect(batches).toHaveBeenCalledTimes(1)
    reads.mockClear()
    batches.mockClear()
  }
})

it('rejects a registration inserted with a different identity after the initial setup read', async () => {
  const insert = D1DestinationStore.prototype.insertIfAbsent
  vi.spyOn(D1DestinationStore.prototype, 'insertIfAbsent').mockImplementationOnce(async function (
    this: D1DestinationStore,
    target,
  ) {
    await seedDestination(env.DB, { ...target, guildId: '2234567890123456789' })
    return insert.call(this, target)
  })
  const { reply } = await execute(command('setup'), mock)
  expect(reply?.content).toBe(apiText().settings.targetMismatch)
  expect(mock.requests).toEqual([])
})

it.each(['eew:b', 'eewlang:s'])('reports a target deleted after the initial %s read', async (action) => {
  await seedDestination(env.DB, CHANNEL_TARGET)
  const update = D1DestinationStore.prototype.update
  vi.spyOn(D1DestinationStore.prototype, 'update').mockImplementationOnce(async function (
    this: D1DestinationStore,
    target,
    change,
  ) {
    await store.remove(target)
    return update.call(this, target, change)
  })
  const { reply } = await execute(component(action, action === 'eew:b' ? ['tsunami'] : ['en_us']), mock)
  expect(reply?.content).toBe(
    action === 'eew:b' ? coreText('ja_jp', 'eewbot.scmd.unregister.notfound') : translate('en_us', 'stale'),
  )
  expect(reply?.components).toEqual([])
})
