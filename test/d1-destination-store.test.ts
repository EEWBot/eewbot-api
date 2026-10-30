import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
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
  it('migrates an empty local D1 with revision zero and the destination indexes', async () => {
    expect(await store.getRevision()).toBe(0)
    expect(await store.loadSnapshot()).toEqual({ revision: 0, destinations: [] })
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_destinations_%'",
    ).all<{ name: string }>()
    expect(results.map((row) => row.name).sort()).toEqual([
      'idx_destinations_channel_id',
      'idx_destinations_guild_id',
      'idx_destinations_webhook_id',
    ])
  })

  it('reapplying tracked migrations preserves data and revision', async () => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD })
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    expect(await store.getRevision()).toBe(1)
    expect(await store.getDestination(CHANNEL)).not.toBeNull()
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first('n')).toBe(env.TEST_MIGRATIONS.length)
  })

  it.each([
    ['an unknown language', "lang = 'xx_xx'"],
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

  it('rejects a channel destination keyed by another ID', async () => {
    await expect(
      env.DB.prepare('INSERT INTO destinations (target_id, channel_id) VALUES (?, ?)').bind(OTHER, CHANNEL).run(),
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

describe('Writes', () => {
  it('inserts a target with column defaults once, without overwriting', async () => {
    expect(await store.insertIfAbsent(CHANNEL_TARGET)).toBe(1)
    await store.update(CHANNEL_TARGET, { flags: FLAGS })
    expect(await store.insertIfAbsent(CHANNEL_TARGET)).toBe(0)
    expect(await store.getDestination(CHANNEL)).toMatchObject({
      ...FLAGS,
      minIntensity: 1,
      lang: 'ja_jp',
      webhook: null,
    })
    expect(await store.getRevision()).toBe(2)
  })

  it('updates flags, intensity, webhook and language, one revision per change', async () => {
    await store.insertIfAbsent(THREAD_TARGET)
    expect(await store.update(THREAD_TARGET, { flags: { quakeInfo: true } })).toBe(1)
    expect(await store.update(THREAD_TARGET, { minIntensity: 7 })).toBe(1)
    expect(await store.update(THREAD_TARGET, { webhook: HOOK })).toBe(1)
    expect(await store.update(THREAD_TARGET, { lang: 'ko_kp' })).toBe(1)
    expect(await store.getDestination(THREAD)).toMatchObject({
      quakeInfo: true,
      minIntensity: 7,
      webhook: HOOK,
      lang: 'ko_kp',
    })
    expect(await store.update(THREAD_TARGET, { webhook: null })).toBe(1)
    expect((await store.getDestination(THREAD))?.webhook).toBeNull()
    expect(await store.getRevision()).toBe(6)
  })

  it('does nothing for an empty flag change', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    expect(await store.update(CHANNEL_TARGET, { flags: {} })).toBe(0)
    expect(await store.getRevision()).toBe(1)
  })

  it('requires the full target identity, not just the target ID', async () => {
    await store.insertIfAbsent(CHANNEL_TARGET)
    const moved = { ...CHANNEL_TARGET, guildId: OTHER }
    expect(await store.update(moved, { minIntensity: 5 })).toBe(0)
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
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
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
