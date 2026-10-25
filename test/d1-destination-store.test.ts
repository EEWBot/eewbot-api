import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { D1DestinationStore, DestinationStorageError } from '../src/db/d1-destination-store'
import type { DestinationConfigSource, DestinationStore } from '../src/db/destination-store'
import type { DestinationFilter, DestinationFlags, Intensity, NewDestination } from '../src/db/destination-types'
import { assertSnowflake, parseWebhookId } from '../src/db/destination-validation'

// Adjacent values above Number.MAX_SAFE_INTEGER must remain distinct everywhere.
const GUILD = '1234567890123456789'
const CHANNEL = '1234567890123456790'
const THREAD = '1234567890123456791'
const WEBHOOK = '1234567890123456792'
const OTHER = '1234567890123456793'
// All URLs/tokens in this file are synthetic fixtures, never real credentials.
const URL = `https://discord.com/api/webhooks/${WEBHOOK}/synthetic-test-token?thread_id=${THREAD}`
const FLAGS: DestinationFlags = {
  eewAlert: true, eewPrediction: false, eewDecimation: true, quakeInfo: false, tsunami: true,
}
const FULL: NewDestination = {
  targetId: THREAD, channelId: CHANNEL, threadId: THREAD, guildId: GUILD,
  ...FLAGS, minIntensity: 4, lang: 'en_us', webhookUrl: URL,
}

const store: DestinationStore = new D1DestinationStore(env.DB)
const source: DestinationConfigSource = store

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  // Tests are sequential; reset application state without erasing Wrangler history.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM destinations'),
    env.DB.prepare('DELETE FROM data_migrations'),
    env.DB.prepare('UPDATE config_meta SET channels_revision = 0 WHERE id = 1'),
  ])
})

async function insertDefault(targetId = CHANNEL, guildId: string | null = GUILD) {
  return store.insertDestinationIfAbsent({ targetId, channelId: CHANNEL, guildId })
}

describe('D1 migrations and Java SqlDestinationStorageContract', () => {
  it('migrates an empty local D1 with revision zero and all indexes', async () => {
    expect(await source.getRevision()).toBe(0)
    expect(await source.loadSnapshot()).toEqual({ revision: 0, destinations: [] })
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_destinations_%'").all<{ name: string }>()
    expect(results.map((row) => row.name).sort()).toEqual([
      'idx_destinations_channel_id', 'idx_destinations_guild_id', 'idx_destinations_thread_id',
      'idx_destinations_webhook_id', 'idx_destinations_webhook_url',
    ])
    await env.DB.prepare('INSERT INTO data_migrations (name) VALUES (?)').bind('synthetic-import').run()
    const history = await env.DB.prepare('SELECT * FROM data_migrations').first()
    expect(history).toMatchObject({ name: 'synthetic-import', checksum: '', meta: null })
    expect(history?.applied_at).toEqual(expect.any(String))
  })

  it('reapplying tracked migrations preserves data, revision and separate histories', async () => {
    await insertDefault()
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
    expect(await source.getRevision()).toBe(1)
    expect(await store.destinationExists(CHANNEL)).toBe(true)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM d1_migrations').first('n')).toBe(env.TEST_MIGRATIONS.length)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM data_migrations').first('n')).toBe(0)
  })

  it('round trips every field and the immutable snapshot without Snowflake rounding', async () => {
    expect(await store.insertDestinationIfAbsent(FULL)).toBe(1)
    const expected = { ...FULL, webhookId: WEBHOOK }
    expect(await store.getDestination(THREAD)).toEqual(expected)
    expect(await store.getAllDestinations()).toEqual([expected])
    const snapshot = await source.loadSnapshot()
    expect(snapshot).toEqual({ revision: 1, destinations: [expected] })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.destinations)).toBe(true)
    expect(Object.isFrozen(snapshot.destinations[0])).toBe(true)
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    const types = await env.DB.prepare(`SELECT typeof(target_id) AS target, typeof(channel_id) AS channel,
      typeof(thread_id) AS thread, typeof(guild_id) AS guild, typeof(webhook_id) AS webhook FROM destinations`).first()
    expect(types).toEqual({ target: 'text', channel: 'text', thread: 'text', guild: 'text', webhook: 'text' })
  })

  it('keeps adjacent 64-bit IDs distinct in insert, retrieval, lookup and delete', async () => {
    for (const targetId of [GUILD, CHANNEL, THREAD]) {
      await store.insertDestinationIfAbsent({ targetId, channelId: targetId, webhookUrl: `https://discord.com/api/webhooks/${targetId}/synthetic` })
    }
    expect((await store.getAllDestinations()).map((row) => row.targetId)).toEqual([GUILD, CHANNEL, THREAD])
    for (const targetId of [GUILD, CHANNEL, THREAD]) {
      expect((await store.getDestination(targetId))?.webhookId).toBe(targetId)
      expect(await store.isWebhookExclusiveToTarget(targetId, targetId)).toBe(true)
      expect(await store.isWebhookExclusiveToTarget(targetId, OTHER)).toBe(false)
    }
    expect(await store.removeDestination(CHANNEL)).toBe(1)
    expect(await store.getDestination(CHANNEL)).toBeNull()
    expect((await store.getAllDestinations()).map((row) => row.targetId)).toEqual([GUILD, THREAD])
    expect(await store.clearWebhookByUrls([`https://discord.com/api/webhooks/${GUILD}/synthetic`])).toBe(1)
    expect((await store.getDestination(THREAD))?.webhookId).toBe(THREAD)
  })

  it('uses SQL and Java defaults, preserving nulls and explicit false/zero/empty language', async () => {
    await env.DB.prepare('INSERT INTO destinations (target_id, channel_id) VALUES (?, ?)').bind(CHANNEL, CHANNEL).run()
    expect(await store.getDestination(CHANNEL)).toEqual({
      targetId: CHANNEL, channelId: CHANNEL, threadId: null, guildId: null,
      eewAlert: false, eewPrediction: false, eewDecimation: false, quakeInfo: false, tsunami: false,
      minIntensity: 1, lang: 'ja_jp', webhookUrl: null, webhookId: null,
    })
    await store.insertDestinationIfAbsent({ targetId: THREAD, channelId: CHANNEL, lang: null, minIntensity: null })
    expect(await store.getDestination(THREAD)).toMatchObject({ lang: 'ja_jp', minIntensity: 1, threadId: null, guildId: null })
    await store.insertDestinationIfAbsent({ targetId: OTHER, channelId: CHANNEL, lang: '', minIntensity: 0 })
    expect(await store.getDestination(OTHER)).toMatchObject({ lang: '', minIntensity: 0, tsunami: false })
  })

  it('does not overwrite duplicate targets or increment revision', async () => {
    await store.insertDestinationIfAbsent(FULL)
    expect(await store.insertDestinationIfAbsent({ targetId: THREAD, channelId: OTHER, lang: 'ja_jp' })).toBe(0)
    expect(await store.getDestination(THREAD)).toEqual({ ...FULL, webhookId: WEBHOOK })
    expect(await source.getRevision()).toBe(1)
  })

  it('sets multiple flags in one mutation and validates the whole allowlist before writing', async () => {
    await insertDefault()
    expect(await store.setFlags(CHANNEL, FLAGS)).toBe(1)
    expect(await source.getRevision()).toBe(2)
    expect(await store.getDestination(CHANNEL)).toMatchObject(FLAGS)
    await expect(store.setFlags(CHANNEL, { eewAlert: false, 'lang = NULL --': true } as Partial<DestinationFlags>)).rejects.toThrow('Unknown destination flag')
    await expect(store.setFlags(CHANNEL, JSON.parse('{"__proto__":true}'))).rejects.toThrow('Unknown destination flag')
    await expect(store.setFlags(CHANNEL, { tsunami: 1 } as unknown as Partial<DestinationFlags>)).rejects.toThrow('boolean')
    expect(await source.getRevision()).toBe(2)
    expect((await store.getDestination(CHANNEL))?.eewAlert).toBe(true)
  })

  it.each(['eewAlert', 'eewPrediction', 'eewDecimation', 'quakeInfo', 'tsunami'] as const)(
    'sets %s on and off and increments for a same-value setter', async (flag) => {
      await insertDefault()
      expect(await store.setFlags(CHANNEL, { [flag]: true })).toBe(1)
      expect((await store.getDestination(CHANNEL))?.[flag]).toBe(true)
      expect(await store.setFlags(CHANNEL, { [flag]: true })).toBe(1)
      expect(await source.getRevision()).toBe(3)
      await store.setFlags(CHANNEL, { [flag]: false })
      expect((await store.getDestination(CHANNEL))?.[flag]).toBe(false)
      expect(await source.getRevision()).toBe(4)
    },
  )

  it('updates language, intensity and webhook, including same-value/null setters', async () => {
    await insertDefault()
    const setters = [
      () => store.setLanguage(CHANNEL, 'en_us'),
      () => store.setMinIntensity(CHANNEL, 9),
      () => store.setWebhook(CHANNEL, URL),
      () => store.setWebhook(CHANNEL, null),
    ]
    let revision = 1
    for (const setter of setters) {
      expect(await setter()).toBe(1)
      expect(await setter()).toBe(1)
      revision += 2
      expect(await source.getRevision()).toBe(revision)
    }
    expect(await store.getDestination(CHANNEL)).toMatchObject({ lang: 'en_us', minIntensity: 9, webhookUrl: null, webhookId: null })
    await expect(store.setLanguage(CHANNEL, null as unknown as string)).rejects.toThrow('non-null')
    await expect(store.setLanguageByGuildId(GUILD, null as unknown as string)).rejects.toThrow('non-null')
    await expect(store.setMinIntensity(CHANNEL, 10 as Intensity)).rejects.toThrow('intensity')
    expect(await source.getRevision()).toBe(revision)
  })

  it('treats every missing-target mutation and empty batch as a no-op even after earlier writes', async () => {
    await insertDefault()
    const operations = [
      () => store.removeDestination(OTHER), () => store.setFlags(OTHER, FLAGS),
      () => store.setMinIntensity(OTHER, 3), () => store.setWebhook(OTHER, URL),
      () => store.setLanguage(OTHER, 'en_us'), () => store.removeByGuildId(OTHER),
      () => store.setLanguageByGuildId(OTHER, 'en_us'), () => store.setFlags(CHANNEL, {}),
      () => store.clearWebhookByUrls([]), () => store.clearWebhookByUrls(['invalid', URL]),
    ]
    for (const operation of operations) {
      expect(await operation()).toBe(0)
      expect(await source.getRevision()).toBe(1)
    }
    expect(await store.destinationExists(OTHER)).toBe(false)
    expect(await store.getDestination(OTHER)).toBeNull()
  })

  it('increments once per guild batch and deletes targets without cascading to siblings', async () => {
    await insertDefault()
    await store.insertDestinationIfAbsent({ targetId: THREAD, channelId: CHANNEL, threadId: THREAD, guildId: GUILD })
    await insertDefault(OTHER, null)
    expect(await store.setLanguageByGuildId(GUILD, 'en_us')).toBe(2)
    expect(await source.getRevision()).toBe(4)
    expect(await store.setLanguageByGuildId(GUILD, 'en_us')).toBe(2)
    expect(await source.getRevision()).toBe(5)
    expect((await store.getDestination(OTHER))?.lang).toBe('ja_jp')
    expect(await store.removeDestination(CHANNEL)).toBe(1)
    expect(await store.destinationExists(THREAD)).toBe(true)
    expect(await store.removeByGuildId(GUILD)).toBe(1)
    expect(await source.getRevision()).toBe(7)
    expect(await store.destinationExists(OTHER)).toBe(true)
  })

  it('deletes multiple guild rows with exactly one revision increment', async () => {
    await insertDefault()
    await store.insertDestinationIfAbsent({ targetId: THREAD, channelId: CHANNEL, threadId: THREAD, guildId: GUILD })
    expect(await store.removeByGuildId(GUILD)).toBe(2)
    expect(await source.loadSnapshot()).toEqual({ revision: 3, destinations: [] })
  })

  it('matches webhooks by ID across channels/threads and preserves the original URL query', async () => {
    await store.insertDestinationIfAbsent(FULL)
    expect(await store.isWebhookExclusiveToTarget(WEBHOOK, THREAD)).toBe(true)
    expect(await store.isWebhookExclusiveToTarget(WEBHOOK, CHANNEL)).toBe(false)
    await store.insertDestinationIfAbsent({ targetId: CHANNEL, channelId: CHANNEL, webhookUrl: `https://discord.com/api/webhooks/${WEBHOOK}/synthetic-other-token` })
    // Duplicates are deliberately allowed in storage; exclusivity is an advisory read.
    expect(await store.isWebhookExclusiveToTarget(WEBHOOK, THREAD)).toBe(false)
    expect(await store.isWebhookExclusiveToTarget(WEBHOOK, CHANNEL)).toBe(false)
    expect(await store.isWebhookExclusiveToTarget(OTHER, CHANNEL)).toBe(true)
    expect((await store.getDestination(THREAD))?.webhookUrl).toBe(URL)
    expect(await store.clearWebhookByUrls([
      `https://discord.com/api/webhooks/${WEBHOOK}/synthetic?thread_id=${OTHER}`,
      URL, 'not-a-url',
    ])).toBe(2)
    expect(await source.getRevision()).toBe(3)
    for (const destination of await store.getAllDestinations()) {
      expect(destination.webhookUrl).toBeNull()
      expect(destination.webhookId).toBeNull()
    }
    expect(await store.clearWebhookByUrls([URL])).toBe(0)
    expect(await source.getRevision()).toBe(3)
  })

  it('clears more than D1 bound-parameter limit in one revision using string JSON IDs', async () => {
    await store.insertDestinationIfAbsent(FULL)
    const urls = Array.from({ length: 125 }, (_, i) => `https://discord.com/api/webhooks/${1000 + i}/synthetic`)
    expect(await store.clearWebhookByUrls([...urls, URL])).toBe(1)
    expect(await source.getRevision()).toBe(2)
  })

  it('filters absent webhooks with Java flag/intensity/null semantics', async () => {
    await insertDefault(CHANNEL, null)
    await store.insertDestinationIfAbsent({ ...FULL, webhookUrl: null })
    await store.insertDestinationIfAbsent({ targetId: OTHER, channelId: OTHER, guildId: GUILD, webhookUrl: URL })
    const scenarios: [DestinationFilter, string[]][] = [
      [{}, [CHANNEL, THREAD]], [{ hasGuild: true }, [THREAD]], [{ hasGuild: false }, [CHANNEL]],
      [{ guildId: GUILD }, [THREAD]], [{ guildId: null }, [CHANNEL]],
      [{ channelId: CHANNEL }, [CHANNEL, THREAD]], [{ threadId: null }, [CHANNEL]],
      [{ threadId: THREAD }, [THREAD]], [{ isThread: true }, [THREAD]], [{ isThread: false }, [CHANNEL]],
      [{ eewAlert: true }, [THREAD]], [{ eewAlert: false }, [CHANNEL]],
      [{ eewPrediction: true }, []], [{ eewPrediction: false }, [CHANNEL, THREAD]],
      [{ eewDecimation: true }, [THREAD]], [{ eewDecimation: false }, [CHANNEL]],
      [{ quakeInfo: true }, []], [{ quakeInfo: false }, [CHANNEL, THREAD]],
      [{ tsunami: true }, [THREAD]], [{ tsunami: false }, [CHANNEL]],
      [{ intensity: 3 }, [CHANNEL]], [{ intensity: 4 }, [CHANNEL, THREAD]],
      [{ webhookId: WEBHOOK }, []], [{ webhookId: null }, [CHANNEL, THREAD]],
      [{ threadId: undefined, hasGuild: null }, [CHANNEL, THREAD]],
      [{ hasGuild: true, isThread: true, tsunami: true, intensity: 4 }, [THREAD]],
    ]
    for (const [filter, ids] of scenarios) {
      expect((await store.getWebhookAbsentDestinations(filter)).map((row) => row.targetId)).toEqual(ids)
    }
  })
})

describe('D1 transaction atomicity and concurrency', () => {
  it('keeps changes() bound to the preceding statement, including no-op and multi-row writes', async () => {
    await insertDefault()
    await insertDefault(THREAD)
    const result = await env.DB.batch([
      env.DB.prepare('UPDATE destinations SET lang = lang WHERE guild_id = ?').bind(GUILD),
      env.DB.prepare('SELECT changes() AS n'),
      env.DB.prepare('DELETE FROM destinations WHERE target_id = ?').bind(OTHER),
      env.DB.prepare('SELECT changes() AS n'),
    ])
    expect(result[1].results).toEqual([{ n: 2 }])
    expect(result[3].results).toEqual([{ n: 0 }])
  })

  it('rolls back a configuration mutation if revision increment fails', async () => {
    await insertDefault()
    await env.DB.prepare(`CREATE TRIGGER fail_revision AFTER UPDATE ON config_meta
      BEGIN SELECT RAISE(ABORT, 'synthetic revision failure'); END`).run()
    try {
      await expect(store.setLanguage(CHANNEL, 'en_us')).rejects.toBeInstanceOf(DestinationStorageError)
      await expect(store.insertDestinationIfAbsent(FULL)).rejects.toBeInstanceOf(DestinationStorageError)
      await expect(store.removeDestination(CHANNEL)).rejects.toBeInstanceOf(DestinationStorageError)
      expect((await store.getDestination(CHANNEL))?.lang).toBe('ja_jp')
      expect(await store.destinationExists(THREAD)).toBe(false)
      expect(await source.getRevision()).toBe(1)
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_revision').run()
    }
  })

  it('rolls back both configuration and already-incremented revision on SQL failure', async () => {
    await insertDefault()
    await expect(env.DB.batch([
      env.DB.prepare('UPDATE destinations SET lang = ? WHERE target_id = ?').bind('en_us', CHANNEL),
      env.DB.prepare('UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1'),
      env.DB.prepare('INSERT INTO config_meta (id) VALUES (2)'),
    ])).rejects.toThrow()
    expect((await store.getDestination(CHANNEL))?.lang).toBe('ja_jp')
    expect(await source.getRevision()).toBe(1)
  })

  it('rolls back earlier rows of a bulk mutation when a later row fails', async () => {
    await insertDefault()
    await insertDefault(THREAD)
    await env.DB.prepare(`CREATE TRIGGER fail_destination BEFORE UPDATE ON destinations
      WHEN NEW.target_id = '${THREAD}' BEGIN SELECT RAISE(ABORT, 'synthetic row failure'); END`).run()
    try {
      await expect(store.setLanguageByGuildId(GUILD, 'en_us')).rejects.toBeInstanceOf(DestinationStorageError)
      expect((await store.getAllDestinations()).map((row) => row.lang)).toEqual(['ja_jp', 'ja_jp'])
      expect(await source.getRevision()).toBe(2)
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_destination').run()
    }
  })

  it('does not expose webhook tokens in validation or database exceptions', async () => {
    await insertDefault()
    const secret = 'synthetic-secret-must-not-appear'
    const malformed = `https://evil.invalid/api/webhooks/${WEBHOOK}/${secret}`
    await expect(store.setWebhook(CHANNEL, malformed)).rejects.toThrow(/^Invalid Discord webhook URL$/)
    await env.DB.prepare(`CREATE TRIGGER fail_secret BEFORE UPDATE ON destinations
      BEGIN SELECT RAISE(ABORT, 'synthetic-secret-must-not-appear'); END`).run()
    try {
      const error = await store.setWebhook(CHANNEL, `https://discord.com/api/webhooks/${WEBHOOK}/${secret}`).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(DestinationStorageError)
      expect(String(error)).not.toContain(secret)
      expect(JSON.stringify(error)).not.toContain(secret)
      expect((error as Error).cause).toBeUndefined()
      expect(await source.getRevision()).toBe(1)
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_secret').run()
    }
  })

  it('rejects revision overflow atomically instead of rounding the counter', async () => {
    await insertDefault()
    await env.DB.prepare('UPDATE config_meta SET channels_revision = ? WHERE id = 1').bind(Number.MAX_SAFE_INTEGER).run()
    await expect(store.setLanguage(CHANNEL, 'en_us')).rejects.toBeInstanceOf(DestinationStorageError)
    expect(await source.getRevision()).toBe(Number.MAX_SAFE_INTEGER)
    expect((await store.getDestination(CHANNEL))?.lang).toBe('ja_jp')
  })

  it('serializes racing insert-if-absent requests into one insert and revision increment', async () => {
    const counts = await Promise.all(Array.from({ length: 20 }, () => store.insertDestinationIfAbsent(FULL)))
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
    expect(await source.getRevision()).toBe(1)
    expect(await store.getDestination(THREAD)).toEqual({ ...FULL, webhookId: WEBHOOK })
  })

  it('does not lose revision increments across independent concurrent store instances', async () => {
    await insertDefault()
    const writers = Array.from({ length: 40 }, () => new D1DestinationStore(env.DB))
    const counts = await Promise.all(writers.map((writer, i) => writer.setLanguage(CHANNEL, i % 2 ? 'en_us' : 'ja_jp')))
    expect(counts.every((n) => n === 1)).toBe(true)
    expect(await source.getRevision()).toBe(41)
    const removals = await Promise.all(writers.map((writer) => writer.removeDestination(CHANNEL)))
    expect(removals.reduce((a, b) => a + b, 0)).toBe(1)
    expect(await source.getRevision()).toBe(42)
  })

  it('reads coherent snapshots during writes and converges after updates stop', async () => {
    const observations = []
    const writers = []
    for (let i = 0; i < 25; i++) {
      const id = String(100 + i)
      writers.push(new D1DestinationStore(env.DB).insertDestinationIfAbsent({ targetId: id, channelId: id }))
      observations.push(source.loadSnapshot())
    }
    const snapshots = await Promise.all(observations)
    await Promise.all(writers)
    for (const snapshot of snapshots) expect(snapshot.revision).toBe(snapshot.destinations.length)
    const latest = await source.loadSnapshot()
    expect(latest.revision).toBe(25)
    expect(latest.destinations).toHaveLength(25)
    expect(await source.getRevision()).toBe(25)
  })
})

describe('ID and webhook validation', () => {
  it.each([GUILD, CHANNEL, THREAD, '1', '18446744073709551615'])('accepts exact decimal Snowflake %s', (id) => {
    expect(() => assertSnowflake(id)).not.toThrow()
  })

  it.each([123, 1234567890123456789n, null, undefined, '', '0', '01', '-1', '1.0', '1e18', ' 1', '1\n', '18446744073709551616'])(
    'rejects invalid/non-string IDs (%s) before D1 binding', async (id) => {
      expect(() => assertSnowflake(id)).toThrow(TypeError)
      await expect(store.getDestination(id as string)).rejects.toThrow(TypeError)
      expect(await source.getRevision()).toBe(0)
    },
  )

  it.each([
    'http://discord.com/api/webhooks/123/synthetic',
    'https://discord.com.evil.invalid/api/webhooks/123/synthetic',
    'https://discord.com@evil.invalid/api/webhooks/123/synthetic',
    'https://discord.com/api/webhooks/not-an-id/synthetic',
    'https://discord.com/api/webhooks/123/',
    'https://discord.com/api/webhooks/123/synthetic/extra',
    'https://discord.com/api/webhooks/123/synthetic#fragment',
    'https://discord.com/api/webhooks/123/synthetic?thread_id=invalid',
    'https://discord.com/api/webhooks/123/synthetic?thread_id=1&thread_id=2',
    'https://discord.com/api/webhooks/123/synthetic\n',
  ])('rejects a malformed webhook without echoing its URL', async (url) => {
    expect(() => parseWebhookId(url)).toThrow(/^Invalid Discord webhook URL$/)
    await expect(store.insertDestinationIfAbsent({ targetId: CHANNEL, channelId: CHANNEL, webhookUrl: url })).rejects.toThrow(/^Invalid Discord webhook URL$/)
    expect(await source.getRevision()).toBe(0)
  })
})
