import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1DestinationStore, type DestinationChange } from '../src/db/d1-destination-store'
import type { DestinationFlags, DestinationTarget } from '../src/db/destination-types'
import { isSnowflake, webhookUrl } from '../src/db/destination-validation'
import { StorageError } from '../src/db/storage-error'
import { resetDb, seedDestination } from './support/fixtures'

// Adjacent values above Number.MAX_SAFE_INTEGER must remain distinct everywhere.
const GUILD = '1234567890123456789'
const CHANNEL = '1234567890123456790'
const THREAD = '1234567890123456791'
const WEBHOOK = '1234567890123456792'
const OTHER = '1234567890123456793'
// All tokens in this file are synthetic fixtures, never real credentials.
const TOKEN = 'synthetic-test-token-0123456789'
const HOOK = { id: WEBHOOK, token: TOKEN }
const FLAGS: DestinationFlags = {
  eewAlert: true,
  eewPrediction: false,
  eewDecimation: true,
  quakeInfo: false,
  tsunami: true,
}
const CHANNEL_TARGET: DestinationTarget = { targetId: CHANNEL, channelId: CHANNEL, guildId: GUILD, threadId: null }
const THREAD_TARGET: DestinationTarget = { targetId: THREAD, channelId: CHANNEL, guildId: GUILD, threadId: THREAD }

const store = new D1DestinationStore(env.DB)

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  await resetDb(env.DB)
})

describe('Schema', () => {
  it('defaults to all intensities when an insert omits min_intensity', async () => {
    await env.DB.prepare('INSERT INTO destinations (target_id, channel_id, created_at, updated_at) VALUES (?, ?, 0, 0)')
      .bind(CHANNEL, CHANNEL)
      .run()

    expect((await store.getDestination(CHANNEL))?.minIntensity).toBe(0)
  })

  it('migrates an empty local D1 with revision zero and the destination indexes', async () => {
    expect(await store.getRevision()).toBe(0)
    expect(await store.loadSnapshot()).toEqual({ revision: 0, destinations: [] })
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_destinations_%'",
    ).all<{ name: string }>()
    expect(results.map((row) => row.name).sort()).toEqual(['idx_destinations_guild_id', 'idx_destinations_webhook_id'])
  })

  it('reapplying tracked migrations preserves data and revision', async () => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD })
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    expect(await store.getRevision()).toBe(1)
    expect(await store.getDestination(CHANNEL)).not.toBeNull()
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first('n')).toBe(env.TEST_MIGRATIONS.length)
  })

  it.each([
    ['a non-boolean flag', 'eew_alert = 2'],
    ['an out-of-range intensity', 'min_intensity = 10'],
    ['a webhook ID without a token', `webhook_id = '${WEBHOOK}'`],
    ['a webhook token without an ID', `webhook_token = '${TOKEN}'`],
    ['a thread ID different from the target', `thread_id = '${OTHER}'`],
  ])('rejects %s with a CHECK constraint', async (_, assignment) => {
    await seedDestination(env.DB, { targetId: CHANNEL })
    await expect(
      env.DB.prepare(`UPDATE destinations SET ${assignment} WHERE target_id = ?`).bind(CHANNEL).run(),
    ).rejects.toThrow(/CHECK/)
  })

  it('allows additional languages and message indexes above fifteen without rebuilding tables', async () => {
    await seedDestination(env.DB, { targetId: CHANNEL })
    await env.DB.prepare("UPDATE destinations SET lang = 'xx_xx'").run()
    await env.DB.prepare(
      "INSERT INTO quake_messages (snapshot_id, lang, message_index, embeds_json) VALUES ('test', 'xx_xx', 16, '[]')",
    ).run()
    expect(await env.DB.prepare('SELECT lang FROM destinations').first('lang')).toBe('xx_xx')
    expect(await env.DB.prepare('SELECT message_index FROM quake_messages').first('message_index')).toBe(16)
    await expect(
      env.DB.prepare(
        "INSERT INTO quake_messages (snapshot_id, lang, message_index, embeds_json) VALUES ('test', 'xx_xx', -1, '[]')",
      ).run(),
    ).rejects.toThrow(/CHECK/)
  })

  it('rejects a channel destination keyed by another ID', async () => {
    await expect(
      env.DB.prepare('INSERT INTO destinations (target_id, channel_id, created_at, updated_at) VALUES (?, ?, 0, 0)')
        .bind(OTHER, CHANNEL)
        .run(),
    ).rejects.toThrow(/CHECK/)
  })
})

describe('Reads', () => {
  it('round trips every field and the immutable snapshot without Snowflake rounding', async () => {
    const seeded = await seedDestination(env.DB, {
      ...THREAD_TARGET,
      ...FLAGS,
      minIntensity: 4,
      lang: 'en_us',
      webhook: HOOK,
    })
    expect(await store.getDestination(THREAD)).toEqual(seeded)
    const snapshot = await store.loadSnapshot()
    expect(snapshot).toEqual({ revision: 1, destinations: [seeded] })
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    const types = await env.DB.prepare(`SELECT typeof(target_id) AS target, typeof(channel_id) AS channel,
      typeof(thread_id) AS thread, typeof(guild_id) AS guild, typeof(webhook_id) AS webhook FROM destinations`).first()
    expect(types).toEqual({ target: 'text', channel: 'text', thread: 'text', guild: 'text', webhook: 'text' })
  })

  it('orders the snapshot by target ID and keeps adjacent 64-bit IDs distinct', async () => {
    for (const targetId of [THREAD, GUILD, CHANNEL]) await seedDestination(env.DB, { targetId })
    expect((await store.loadSnapshot()).destinations.map((d) => d.targetId)).toEqual([GUILD, CHANNEL, THREAD])
  })
})

describe('Webhook assignment', () => {
  it('selects the first available candidate in input order and keeps its token paired with its ID', async () => {
    await seedDestination(env.DB, { ...THREAD_TARGET, webhook: HOOK })
    await store.insertIfAbsent(CHANNEL_TARGET)
    const before = await store.getRevision()
    const first = { id: '18446744073709551614', token: `${TOKEN}-first` }
    const second = { id: OTHER, token: `${TOKEN}-second` }
    expect(await store.assignAvailableWebhook(CHANNEL_TARGET, [HOOK, first, second])).toMatchObject({
      changes: 1,
      destination: { ...CHANNEL_TARGET, webhook: first },
    })
    expect((await store.getDestination(CHANNEL))?.webhook).toEqual(first)
    expect((await store.getDestination(THREAD))?.webhook).toEqual(HOOK)
    expect(await store.getRevision()).toBe(before + 1)
  })

  it('uses numeric candidate order with a list larger than the bound-parameter limit', async () => {
    await seedDestination(env.DB, { ...THREAD_TARGET, webhook: HOOK })
    await store.insertIfAbsent(CHANNEL_TARGET)
    const first = { id: OTHER, token: `${TOKEN}-first` }
    const second = { id: '18446744073709551614', token: `${TOKEN}-second` }
    const candidates = Array.from({ length: 120 }, () => HOOK)
    candidates[2] = first
    candidates[10] = second
    expect(await store.assignAvailableWebhook(CHANNEL_TARGET, candidates)).toMatchObject({ changes: 1 })
    expect((await store.getDestination(CHANNEL))?.webhook).toEqual(first)
  })

  it('leaves the assignment and revision unchanged when the candidate list is empty or fully occupied', async () => {
    await seedDestination(env.DB, { ...CHANNEL_TARGET, webhook: HOOK })
    const occupied = { id: OTHER, token: `${TOKEN}-occupied` }
    const current = { id: GUILD, token: `${TOKEN}-current` }
    await seedDestination(env.DB, { targetId: OTHER, guildId: GUILD, webhook: occupied })
    await seedDestination(env.DB, { ...THREAD_TARGET, webhook: current })
    const before = await store.loadSnapshot()
    expect(await store.assignAvailableWebhook(THREAD_TARGET, [])).toMatchObject({ changes: 0 })
    expect(await store.assignAvailableWebhook(THREAD_TARGET, [HOOK, occupied])).toMatchObject({ changes: 0 })
    expect(await store.loadSnapshot()).toEqual(before)
  })

  it('claims an available webhook, refreshes its token, and leaves identical assignments unchanged', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    const before = await store.getRevision()
    expect(await store.assignAvailableWebhook(CHANNEL_TARGET, [HOOK])).toMatchObject({ changes: 1 })
    expect(await store.assignAvailableWebhook(CHANNEL_TARGET, [HOOK])).toMatchObject({
      changes: 0,
      destination: { webhook: HOOK },
    })
    expect(await store.getRevision()).toBe(before + 1)
    const refreshed = { ...HOOK, token: `${TOKEN}-refreshed` }
    expect(await store.assignAvailableWebhook(CHANNEL_TARGET, [refreshed])).toMatchObject({ changes: 1 })
    expect((await store.getDestination(CHANNEL))?.webhook).toEqual(refreshed)
    expect(await store.getRevision()).toBe(before + 2)
  })

  it('refuses a webhook assigned elsewhere without changing the current assignment or revision', async () => {
    await seedDestination(env.DB, { ...CHANNEL_TARGET, webhook: HOOK })
    await seedDestination(env.DB, { ...THREAD_TARGET, webhook: { id: OTHER, token: TOKEN } })
    const before = await store.loadSnapshot()
    expect(await store.assignAvailableWebhook(THREAD_TARGET, [HOOK])).toMatchObject({ changes: 0 })
    expect(await store.loadSnapshot()).toEqual(before)
  })

  it('lets only one of two concurrent destinations claim the same unassigned webhook', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await store.insertIfAbsent(THREAD_TARGET)
    const before = await store.getRevision()
    const results = await Promise.all([
      store.assignAvailableWebhook(CHANNEL_TARGET, [HOOK]),
      store.assignAvailableWebhook(THREAD_TARGET, [HOOK]),
    ])
    expect(results.map((result) => result.changes).sort()).toEqual([0, 1])
    expect((await store.loadSnapshot()).destinations.filter((d) => d.webhook?.id === WEBHOOK)).toHaveLength(1)
    expect(await store.getRevision()).toBe(before + 1)
  })

  it('selects distinct available candidates for concurrent destinations using the same list', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await store.insertIfAbsent(THREAD_TARGET)
    const before = await store.getRevision()
    const second = { id: OTHER, token: `${TOKEN}-second` }
    const unused = { id: GUILD, token: `${TOKEN}-unused` }
    const candidates = [HOOK, second, unused]
    expect(
      await Promise.all([
        store.assignAvailableWebhook(CHANNEL_TARGET, candidates),
        store.assignAvailableWebhook(THREAD_TARGET, candidates),
      ]),
    ).toMatchObject([{ changes: 1 }, { changes: 1 }])
    expect((await store.loadSnapshot()).destinations.map((d) => d.webhook)).toEqual(
      expect.arrayContaining([HOOK, second]),
    )
    expect(await store.getRevision()).toBe(before + 2)
  })

  it('does not assign a webhook to an absent or mismatched target', async () => {
    expect(await store.assignAvailableWebhook(CHANNEL_TARGET, [HOOK])).toMatchObject({ changes: 0 })
    await store.insertIfAbsent(THREAD_TARGET)
    const before = await store.loadSnapshot()
    expect(await store.assignAvailableWebhook({ ...THREAD_TARGET, channelId: OTHER }, [HOOK])).toMatchObject({
      changes: 0,
    })
    expect(await store.assignAvailableWebhook({ ...THREAD_TARGET, guildId: OTHER }, [HOOK])).toMatchObject({
      changes: 0,
    })
    expect(await store.loadSnapshot()).toEqual(before)
  })
})

describe('Writes', () => {
  it('returns the inserted or existing destination, including unchanged updates', async () => {
    const inserted = await store.insertIfAbsent(CHANNEL_TARGET)
    expect(inserted).toMatchObject({ changes: 1, destination: { ...CHANNEL_TARGET, minIntensity: 0, webhook: null } })
    expect(await store.insertIfAbsent(CHANNEL_TARGET)).toEqual({ ...inserted, changes: 0 })
    const updated = await store.update(CHANNEL_TARGET, { flags: FLAGS })
    expect(updated).toEqual({ changes: 1, destination: { ...inserted.destination, ...FLAGS } })
    expect(await store.update(CHANNEL_TARGET, { flags: FLAGS })).toEqual({ ...updated, changes: 0 })
    expect(await store.update(CHANNEL_TARGET, { flags: {} })).toEqual({ ...updated, changes: 0 })
    expect(await store.getRevision()).toBe(2)
  })

  it('distinguishes absent and mismatched targets in the row returned after a no-op', async () => {
    expect(await store.update(CHANNEL_TARGET, { lang: 'en_us' })).toEqual({ changes: 0, destination: null })
    const destination = await seedDestination(env.DB, { ...THREAD_TARGET, webhook: HOOK })
    const moved = { ...THREAD_TARGET, channelId: OTHER }
    expect(await store.update(moved, { lang: 'en_us' })).toEqual({ changes: 0, destination })
    expect(await store.assignAvailableWebhook(moved, [HOOK])).toEqual({ changes: 0, destination })
    expect(await store.assignAvailableWebhook(THREAD_TARGET, [])).toEqual({ changes: 0, destination })
    expect(await store.getRevision()).toBe(1)
  })

  it('returns the state produced by each concurrent write in its own transaction', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    const results = await Promise.all([
      store.update(CHANNEL_TARGET, { lang: 'en_us' }),
      store.update(CHANNEL_TARGET, { lang: 'zh_tw' }),
    ])
    expect(results).toMatchObject([
      { changes: 1, destination: { lang: 'en_us' } },
      { changes: 1, destination: { lang: 'zh_tw' } },
    ])
    expect(await store.getRevision()).toBe(3)
  })

  it('returns the selected destination after a guild language batch, including a no-op', async () => {
    const destination = await seedDestination(env.DB, { ...CHANNEL_TARGET, lang: 'en_us' })
    await seedDestination(env.DB, THREAD_TARGET)
    expect(await store.setGuildLanguage(GUILD, 'en_us', CHANNEL)).toEqual({ changes: 1, destination })
    expect(await store.setGuildLanguage(GUILD, 'en_us', CHANNEL)).toEqual({ changes: 0, destination })
    expect(await store.setGuildLanguage(GUILD, 'en_us', OTHER)).toEqual({ changes: 0, destination: null })
    expect(await store.getRevision()).toBe(3)
  })

  it('tracks insert, bulk updates, cleanup and import times without changing creation time', async () => {
    const clock = vi.spyOn(Date, 'now')
    const times = (id: string) =>
      env.DB.prepare('SELECT created_at, updated_at FROM destinations WHERE target_id = ?').bind(id).first()
    try {
      clock.mockReturnValue(1000)
      await store.insertIfAbsent(CHANNEL_TARGET)
      await store.insertIfAbsent(THREAD_TARGET)
      expect(await times(CHANNEL)).toEqual({ created_at: 1000, updated_at: 1000 })
      clock.mockReturnValue(2000)
      await store.update(CHANNEL_TARGET, { webhook: HOOK })
      expect(await times(CHANNEL)).toEqual({ created_at: 1000, updated_at: 2000 })
      clock.mockReturnValue(3000)
      await store.setGuildLanguage(GUILD, 'en_us')
      expect(await times(THREAD)).toEqual({ created_at: 1000, updated_at: 3000 })
      clock.mockReturnValue(4000)
      await store.clearWebhooksByIds([WEBHOOK])
      expect(await times(CHANNEL)).toEqual({ created_at: 1000, updated_at: 4000 })
      await store.update(THREAD_TARGET, { webhook: HOOK })
      clock.mockReturnValue(5000)
      await store.clearWebhooksByTargets([{ targetId: THREAD, expectedWebhookId: WEBHOOK }])
      expect(await times(THREAD)).toEqual({ created_at: 1000, updated_at: 5000 })
      const row = (await store.getDestination(CHANNEL))!
      clock.mockReturnValue(6000)
      await store.importDestinations([
        { ...row, quakeInfo: true },
        { ...row, targetId: OTHER, channelId: OTHER },
      ])
      expect(await times(CHANNEL)).toEqual({ created_at: 1000, updated_at: 6000 })
      expect(await times(OTHER)).toEqual({ created_at: 6000, updated_at: 6000 })
      const revision = await store.getRevision()
      clock.mockReturnValue(7000)
      expect(await store.importDestinations([{ ...row, quakeInfo: true }])).toBe(0)
      expect(await store.insertIfAbsent(CHANNEL_TARGET)).toMatchObject({ changes: 0 })
      expect(await store.update(CHANNEL_TARGET, { flags: {} })).toMatchObject({ changes: 0 })
      expect(await times(CHANNEL)).toEqual({ created_at: 1000, updated_at: 6000 })
      expect(await store.getRevision()).toBe(revision)
    } finally {
      clock.mockRestore()
    }
  })

  it.each<DestinationChange>([
    { flags: { eewAlert: true, quakeInfo: false, tsunami: true } },
    { minIntensity: 7 },
    { lang: 'en_us' },
    { webhook: HOOK },
    { webhook: null },
  ])('keeps revision and timestamps unchanged when repeating %j', async (change) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      await store.insertIfAbsent(CHANNEL_TARGET)
      await store.update(CHANNEL_TARGET, change)
      const before = await env.DB.prepare('SELECT * FROM destinations').first()
      const revision = await store.getRevision()
      clock.mockReturnValue(2000)
      expect(await store.update(CHANNEL_TARGET, change)).toMatchObject({ changes: 0 })
      expect(await store.getRevision()).toBe(revision)
      expect(await env.DB.prepare('SELECT * FROM destinations').first()).toEqual(before)
    } finally {
      clock.mockRestore()
    }
  })

  it('updates flags when only one of the supplied columns differs', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    expect(await store.update(CHANNEL_TARGET, { flags: { eewAlert: false, tsunami: true } })).toMatchObject({
      changes: 1,
    })
    expect(await store.getDestination(CHANNEL)).toMatchObject({ eewAlert: false, tsunami: true })
    expect(await store.getRevision()).toBe(2)
  })

  it('compares both webhook columns including nulls', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await store.update(CHANNEL_TARGET, { webhook: HOOK })
    expect(await store.update(CHANNEL_TARGET, { webhook: { ...HOOK, token: `${TOKEN}-changed` } })).toMatchObject({
      changes: 1,
    })
    expect(await store.update(CHANNEL_TARGET, { webhook: { id: OTHER, token: `${TOKEN}-changed` } })).toMatchObject({
      changes: 1,
    })
    expect(await store.update(CHANNEL_TARGET, { webhook: null })).toMatchObject({ changes: 1 })
    expect(await store.update(CHANNEL_TARGET, { webhook: null })).toMatchObject({ changes: 0 })
    expect(await store.getRevision()).toBe(5)
  })

  it('only updates guild rows whose language differs and leaves repeat applies untouched', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      await store.insertIfAbsent(CHANNEL_TARGET)
      await store.insertIfAbsent(THREAD_TARGET)
      await store.update(CHANNEL_TARGET, { lang: 'en_us' })
      clock.mockReturnValue(2000)
      expect(await store.setGuildLanguage(GUILD, 'en_us')).toBe(1)
      expect(
        await env.DB.prepare('SELECT target_id, updated_at FROM destinations ORDER BY target_id').all(),
      ).toMatchObject({
        results: [
          { target_id: CHANNEL, updated_at: 1000 },
          { target_id: THREAD, updated_at: 2000 },
        ],
      })
      expect(await store.getRevision()).toBe(4)
      clock.mockReturnValue(3000)
      expect(await store.setGuildLanguage(GUILD, 'en_us')).toBe(0)
      expect(await store.getRevision()).toBe(4)
      expect(
        await env.DB.prepare('SELECT updated_at FROM destinations WHERE target_id = ?')
          .bind(THREAD)
          .first('updated_at'),
      ).toBe(2000)
    } finally {
      clock.mockRestore()
    }
  })

  it('inserts a target with all intensities enabled once, without overwriting', async () => {
    expect(await store.insertIfAbsent(CHANNEL_TARGET)).toMatchObject({ changes: 1 })
    await store.update(CHANNEL_TARGET, { flags: FLAGS })
    expect(await store.insertIfAbsent(CHANNEL_TARGET)).toMatchObject({ changes: 0 })
    expect(await store.getDestination(CHANNEL)).toMatchObject({
      ...FLAGS,
      minIntensity: 0,
      lang: 'ja_jp',
      webhook: null,
    })
    expect(await store.getRevision()).toBe(2)
  })

  it('updates flags, intensity, webhook and language, one revision per change', async () => {
    await store.insertIfAbsent(THREAD_TARGET)
    expect(await store.update(THREAD_TARGET, { flags: { quakeInfo: true } })).toMatchObject({ changes: 1 })
    expect(await store.update(THREAD_TARGET, { minIntensity: 7 })).toMatchObject({ changes: 1 })
    expect(await store.update(THREAD_TARGET, { webhook: HOOK })).toMatchObject({ changes: 1 })
    expect(await store.update(THREAD_TARGET, { lang: 'ko_kp' })).toMatchObject({ changes: 1 })
    expect(await store.getDestination(THREAD)).toMatchObject({
      quakeInfo: true,
      minIntensity: 7,
      webhook: HOOK,
      lang: 'ko_kp',
    })
    expect(await store.update(THREAD_TARGET, { webhook: null })).toMatchObject({ changes: 1 })
    expect((await store.getDestination(THREAD))?.webhook).toBeNull()
    expect(await store.getRevision()).toBe(6)
  })

  it('does nothing for an empty flag change', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    expect(await store.update(CHANNEL_TARGET, { flags: {} })).toMatchObject({ changes: 0 })
    expect(await store.getRevision()).toBe(1)
  })

  it('requires the full target identity, not just the target ID', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    const moved = { ...CHANNEL_TARGET, guildId: OTHER }
    expect(await store.update(moved, { minIntensity: 5 })).toMatchObject({ changes: 0 })
    expect(await store.remove(moved)).toBe(0)
    expect(await store.getRevision()).toBe(1)
  })

  it('sets the language of every destination in one guild', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await store.insertIfAbsent(THREAD_TARGET)
    await seedDestination(env.DB, { targetId: OTHER, guildId: '2234567890123456789' })
    expect(await store.setGuildLanguage(GUILD, 'en_us')).toBe(2)
    expect((await store.getDestination(OTHER))?.lang).toBe('ja_jp')
    expect(await store.getRevision()).toBe(4)
  })

  it('removes guild rows and exact targets with one revision increment per changed batch', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await store.insertIfAbsent(THREAD_TARGET)
    expect(await store.remove(THREAD_TARGET)).toBe(1)
    expect(await store.removeByGuildId(GUILD)).toBe(1)
    expect(await store.removeByGuildId(GUILD)).toBe(0)
    expect(await store.getRevision()).toBe(4)
  })

  it('clears webhooks by ID beyond the bound-parameter limit, and by guarded target', async () => {
    await seedDestination(env.DB, { ...CHANNEL_TARGET, webhook: HOOK })
    await seedDestination(env.DB, { ...THREAD_TARGET, webhook: { id: OTHER, token: TOKEN } })
    const ids = [WEBHOOK, ...Array.from({ length: 200 }, (_, i) => String(i + 1))]
    expect(await store.clearWebhooksByIds(ids)).toBe(1)
    expect(await store.clearWebhooksByTargets([{ targetId: THREAD, expectedWebhookId: WEBHOOK }])).toBe(0)
    expect(await store.clearWebhooksByTargets([{ targetId: THREAD, expectedWebhookId: OTHER }])).toBe(1)
    expect((await store.loadSnapshot()).destinations.every((d) => d.webhook === null)).toBe(true)
  })

  it('clears only matching target/webhook pairs in a large batch and advances the revision once', async () => {
    await seedDestination(env.DB, { ...CHANNEL_TARGET, webhook: HOOK })
    await seedDestination(env.DB, { ...THREAD_TARGET, webhook: HOOK })
    await seedDestination(env.DB, { targetId: GUILD, webhook: { id: OTHER, token: TOKEN } })
    await seedDestination(env.DB, { targetId: OTHER, webhook: HOOK })
    await seedDestination(env.DB, { targetId: '1' })
    const targets = [
      ...Array.from({ length: 120 }, (_, i) => ({ targetId: String(i + 100), expectedWebhookId: WEBHOOK })),
      { targetId: CHANNEL, expectedWebhookId: WEBHOOK },
      { targetId: CHANNEL, expectedWebhookId: WEBHOOK },
      { targetId: THREAD, expectedWebhookId: WEBHOOK },
      { targetId: CHANNEL, expectedWebhookId: OTHER },
      { targetId: GUILD, expectedWebhookId: WEBHOOK },
      { targetId: '1', expectedWebhookId: WEBHOOK },
    ]
    const before = await store.loadSnapshot()

    expect(await store.clearWebhooksByTargets(targets)).toBe(2)
    const after = await store.loadSnapshot()
    expect(after).toEqual({
      revision: before.revision + 1,
      destinations: before.destinations.map((d) =>
        d.targetId === CHANNEL || d.targetId === THREAD ? { ...d, webhook: null } : d,
      ),
    })
    expect(await store.clearWebhooksByTargets(targets)).toBe(0)
    expect(await store.clearWebhooksByTargets([])).toBe(0)
    expect(await store.loadSnapshot()).toEqual(after)
  })

  it('uses the target primary-key index when clearing webhooks by targets', async () => {
    const targets = [{ targetId: CHANNEL, expectedWebhookId: WEBHOOK }]
    const prepare = vi.spyOn(env.DB, 'prepare')
    try {
      await store.clearWebhooksByTargets(targets)
      const [sql] = prepare.mock.calls[0]!
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(0, JSON.stringify(targets))
        .all<{ detail: string }>()
      const details = results.map((row) => row.detail)
      expect(details).toContain('SEARCH destinations USING INDEX sqlite_autoindex_destinations_1 (target_id=?)')
      expect(details.some((detail) => /SCAN destinations|CORRELATED/.test(detail))).toBe(false)
    } finally {
      prepare.mockRestore()
    }
  })
})

describe('D1 transaction atomicity and concurrency', () => {
  it('keeps changes() bound to the preceding statement, including no-op and multi-row writes', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await store.insertIfAbsent(THREAD_TARGET)
    const result = await env.DB.batch([
      env.DB.prepare('UPDATE destinations SET lang = lang WHERE guild_id = ?').bind(GUILD),
      env.DB.prepare('SELECT changes() AS n'),
      env.DB.prepare('DELETE FROM destinations WHERE target_id = ?').bind(OTHER),
      env.DB.prepare('SELECT changes() AS n'),
    ])
    expect(result[1]?.results).toEqual([{ n: 2 }])
    expect(result[3]?.results).toEqual([{ n: 0 }])
  })

  it('rolls back a configuration mutation if the revision increment fails', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await env.DB.prepare(`CREATE TRIGGER fail_revision AFTER UPDATE ON config_meta
      BEGIN SELECT RAISE(ABORT, 'synthetic revision failure'); END`).run()
    try {
      await expect(store.update(CHANNEL_TARGET, { flags: FLAGS })).rejects.toBeInstanceOf(StorageError)
      await expect(store.assignAvailableWebhook(CHANNEL_TARGET, [HOOK])).rejects.toBeInstanceOf(StorageError)
      await expect(store.insertIfAbsent(THREAD_TARGET)).rejects.toBeInstanceOf(StorageError)
      await expect(store.removeDestinations([CHANNEL])).rejects.toBeInstanceOf(StorageError)
      expect((await store.getDestination(CHANNEL))?.eewAlert).toBe(false)
      expect(await store.getDestination(THREAD)).toBeNull()
      expect(await store.getRevision()).toBe(1)
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_revision').run()
    }
  })

  it('rolls back earlier rows of a bulk mutation when a later row fails', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await store.insertIfAbsent(THREAD_TARGET)
    await env.DB.prepare(`CREATE TRIGGER fail_destination BEFORE DELETE ON destinations
      WHEN OLD.target_id = '${THREAD}' BEGIN SELECT RAISE(ABORT, 'synthetic row failure'); END`).run()
    try {
      await expect(store.removeByGuildId(GUILD)).rejects.toBeInstanceOf(StorageError)
      expect((await store.loadSnapshot()).destinations).toHaveLength(2)
      expect(await store.getRevision()).toBe(2)
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_destination').run()
    }
  })

  it('does not expose webhook tokens in database exceptions', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await env.DB.prepare(`CREATE TRIGGER fail_secret BEFORE UPDATE ON destinations
      BEGIN SELECT RAISE(ABORT, '${TOKEN}'); END`).run()
    try {
      const error = await store.update(CHANNEL_TARGET, { webhook: HOOK }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(StorageError)
      expect(String(error)).not.toContain(TOKEN)
      expect(JSON.stringify(error)).not.toContain(TOKEN)
      expect((error as Error).cause).toBeUndefined()
      expect(await store.getRevision()).toBe(1)
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_secret').run()
    }
  })

  it('rejects revision overflow atomically instead of rounding the counter', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    await env.DB.prepare('UPDATE config_meta SET channels_revision = ? WHERE id = 1')
      .bind(Number.MAX_SAFE_INTEGER)
      .run()
    await expect(store.update(CHANNEL_TARGET, { flags: FLAGS })).rejects.toBeInstanceOf(StorageError)
    expect(await store.getRevision()).toBe(Number.MAX_SAFE_INTEGER)
    expect((await store.getDestination(CHANNEL))?.eewAlert).toBe(false)
  })

  it('serializes racing insert-if-absent requests into one insert and revision increment', async () => {
    const counts = await Promise.all(Array.from({ length: 20 }, () => store.insertIfAbsent(CHANNEL_TARGET)))
    expect(counts.reduce((a, b) => a + b.changes, 0)).toBe(1)
    expect(await store.getRevision()).toBe(1)
  })

  it('reads coherent snapshots during writes and converges after updates stop', async () => {
    const observations = []
    const writers = []
    for (let i = 0; i < 25; i++) {
      const id = String(100 + i)
      writers.push(
        new D1DestinationStore(env.DB).insertIfAbsent({
          targetId: id,
          channelId: id,
          guildId: GUILD,
          threadId: null,
        }),
      )
      observations.push(store.loadSnapshot())
    }
    const snapshots = await Promise.all(observations)
    await Promise.all(writers)
    for (const snapshot of snapshots) expect(snapshot.revision).toBe(snapshot.destinations.length)
    const latest = await store.loadSnapshot()
    expect(latest.revision).toBe(25)
    expect(latest.destinations).toHaveLength(25)
  })
})

describe('ID and webhook helpers', () => {
  it.each([GUILD, CHANNEL, THREAD, '1', '18446744073709551615'])('accepts exact decimal Snowflake %s', (id) => {
    expect(isSnowflake(id)).toBe(true)
  })

  it.each([
    123,
    1234567890123456789n,
    null,
    undefined,
    '',
    '0',
    '01',
    '-1',
    '1.0',
    '1e18',
    ' 1',
    '1\n',
    '18446744073709551616',
  ])('rejects invalid Snowflake %s', (id) => {
    expect(isSnowflake(id)).toBe(false)
  })

  it('builds webhook URLs on the fixed Discord origin', () => {
    expect(webhookUrl(HOOK, null)).toBe(`https://discord.com/api/webhooks/${WEBHOOK}/${TOKEN}`)
    expect(webhookUrl(HOOK, THREAD)).toBe(`https://discord.com/api/webhooks/${WEBHOOK}/${TOKEN}?thread_id=${THREAD}`)
  })
})
