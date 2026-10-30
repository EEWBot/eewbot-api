import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import type { DestinationConfigSource, DestinationStore } from '../src/db/destination-store'
import type { DestinationFlags, DestinationTarget, Intensity } from '../src/db/destination-types'
import { assertSnowflake, webhookUrl } from '../src/db/destination-validation'
import { StorageError } from '../src/db/storage-error'
import { resetDb, seedDestination } from './support/fixtures'

// Adjacent values above Number.MAX_SAFE_INTEGER must remain distinct everywhere.
const GUILD = '1234567890123456789'
const CHANNEL = '1234567890123456790'
const THREAD = '1234567890123456791'
const WEBHOOK = '1234567890123456792'
const OTHER = '1234567890123456793'
const ACTOR = '1234567890123456794'
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
const LOCK_OWNER = 'synthetic-lock-owner'

const store: DestinationStore = new D1DestinationStore(env.DB)
const source: DestinationConfigSource = store

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
  await resetDb(env.DB)
})

async function lock(channelId = CHANNEL, owner = LOCK_OWNER, expiresAt = Date.now() + 60_000) {
  await env.DB.prepare('INSERT INTO discord_setup_locks (channel_id, owner, expires_at) VALUES (?, ?, ?)')
    .bind(channelId, owner, expiresAt)
    .run()
}

async function session(
  id: string,
  kind: 'setup' | 'unregister' | 'lang',
  revision: number,
  expiresAt = Date.now() + 60_000,
) {
  await env.DB.prepare(
    `INSERT INTO discord_sessions (id, kind, actor_id, guild_id, target_id, channel_id, thread_id, revision, language, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(id, kind, ACTOR, GUILD, CHANNEL, CHANNEL, revision, kind === 'lang' ? 'ja_jp' : null, expiresAt)
    .run()
}

describe('Schema', () => {
  it('migrates an empty local D1 with revision zero and the destination indexes', async () => {
    expect(await source.getRevision()).toBe(0)
    expect(await source.loadSnapshot()).toEqual({ revision: 0, destinations: [] })
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
    expect(await source.getRevision()).toBe(1)
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

  it('requires a language exactly for language sessions', async () => {
    await expect(
      session('a'.repeat(32), 'setup', 0).then(() =>
        env.DB.prepare("UPDATE discord_sessions SET language = 'ja_jp'").run(),
      ),
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
    const snapshot = await source.loadSnapshot()
    expect(snapshot).toEqual({ revision: 1, destinations: [seeded] })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.destinations)).toBe(true)
    expect(Object.isFrozen(snapshot.destinations[0])).toBe(true)
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    const types = await env.DB.prepare(`SELECT typeof(target_id) AS target, typeof(channel_id) AS channel,
      typeof(thread_id) AS thread, typeof(guild_id) AS guild, typeof(webhook_id) AS webhook FROM destinations`).first()
    expect(types).toEqual({ target: 'text', channel: 'text', thread: 'text', guild: 'text', webhook: 'text' })
  })

  it('returns the revision together with an absent or present destination', async () => {
    expect(await store.getVersionedDestination(CHANNEL)).toEqual({ revision: 0, destination: null })
    await seedDestination(env.DB, { targetId: CHANNEL })
    const versioned = await store.getVersionedDestination(CHANNEL)
    expect(versioned.revision).toBe(1)
    expect(versioned.destination?.targetId).toBe(CHANNEL)
  })

  it('orders the snapshot by target ID and keeps adjacent 64-bit IDs distinct', async () => {
    for (const targetId of [THREAD, GUILD, CHANNEL]) await seedDestination(env.DB, { targetId })
    expect((await source.loadSnapshot()).destinations.map((d) => d.targetId)).toEqual([GUILD, CHANNEL, THREAD])
  })
})

describe('Writes', () => {
  it('inserts a target with column defaults once, without overwriting or re-incrementing', async () => {
    expect(await store.insertDestinationIfAbsent(CHANNEL_TARGET)).toBe(1)
    expect(await store.getDestination(CHANNEL)).toEqual({
      ...CHANNEL_TARGET,
      eewAlert: false,
      eewPrediction: false,
      eewDecimation: false,
      quakeInfo: false,
      tsunami: false,
      minIntensity: 1,
      lang: 'ja_jp',
      webhook: null,
    })
    expect(await store.insertDestinationIfAbsent({ ...CHANNEL_TARGET, guildId: OTHER })).toBe(0)
    expect((await store.getDestination(CHANNEL))?.guildId).toBe(GUILD)
    expect(await source.getRevision()).toBe(1)
  })

  it('changes flags and intensity only at the expected revision', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    expect(await store.changeIfRevision(CHANNEL_TARGET, 0, { flags: FLAGS })).toBe(0)
    expect(await store.changeIfRevision(CHANNEL_TARGET, 1, { flags: FLAGS })).toBe(1)
    expect(await store.getDestination(CHANNEL)).toMatchObject(FLAGS)
    expect(await store.changeIfRevision(CHANNEL_TARGET, 2, { minIntensity: 9 })).toBe(1)
    expect((await store.getDestination(CHANNEL))?.minIntensity).toBe(9)
    expect(await source.getRevision()).toBe(3)
  })

  it('requires the full target identity, not just the target ID', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    expect(await store.changeIfRevision({ ...CHANNEL_TARGET, guildId: OTHER }, 1, { flags: FLAGS })).toBe(0)
    expect(await source.getRevision()).toBe(1)
  })

  it('validates the whole flag allowlist and value types before writing', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    const change = (flags: unknown) =>
      store.changeIfRevision(CHANNEL_TARGET, 1, { flags: flags as Partial<DestinationFlags> })
    await expect(change({ eewAlert: false, 'lang = NULL --': true })).rejects.toThrow('Unknown destination flag')
    await expect(change(JSON.parse('{"__proto__":true}'))).rejects.toThrow('Unknown destination flag')
    await expect(change({ tsunami: 1 })).rejects.toThrow('boolean')
    await expect(store.changeIfRevision(CHANNEL_TARGET, 1, { minIntensity: 10 as Intensity })).rejects.toThrow(
      'intensity',
    )
    expect(await change({})).toBe(0)
    expect(await source.getRevision()).toBe(1)
  })

  it('assigns a webhook only while holding the channel lock and when no other target uses it', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    const assign = (revision: number) =>
      store.changeIfRevision(CHANNEL_TARGET, revision, { webhook: HOOK, lockOwner: LOCK_OWNER })
    expect(await assign(1)).toBe(0)
    await lock(CHANNEL, LOCK_OWNER, Date.now() - 1)
    expect(await assign(1)).toBe(0)
    await env.DB.prepare('UPDATE discord_setup_locks SET expires_at = ?')
      .bind(Date.now() + 60_000)
      .run()
    expect(await assign(1)).toBe(1)
    expect((await store.getDestination(CHANNEL))?.webhook).toEqual(HOOK)

    await seedDestination(env.DB, { targetId: OTHER, guildId: GUILD })
    const other = { ...CHANNEL_TARGET, targetId: OTHER, channelId: OTHER }
    await lock(OTHER)
    expect(await store.changeIfRevision(other, 3, { webhook: HOOK, lockOwner: LOCK_OWNER })).toBe(0)
    expect(await store.isWebhookExclusiveToTarget(WEBHOOK, CHANNEL)).toBe(true)
    expect(await store.isWebhookExclusiveToTarget(WEBHOOK, OTHER)).toBe(false)
    expect(await store.isWebhookUnassigned(WEBHOOK)).toBe(false)
    expect(await store.isWebhookUnassigned(OTHER)).toBe(true)
  })

  it('rejects malformed webhook credentials without echoing the token', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    const secret = 'short$secret'
    const error = await store
      .changeIfRevision(CHANNEL_TARGET, 1, { webhook: { id: WEBHOOK, token: secret }, lockOwner: LOCK_OWNER })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TypeError)
    expect(String(error)).not.toContain(secret)
  })

  it('applies session-guarded changes only for a live session of the matching kind', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    const id = 'b'.repeat(32)
    const guard = { id, actorId: ACTOR }
    expect(await store.changeIfRevision(CHANNEL_TARGET, 1, { flags: FLAGS }, guard)).toBe(0)
    await session(id, 'unregister', 1)
    expect(await store.changeIfRevision(CHANNEL_TARGET, 1, { flags: FLAGS }, guard)).toBe(0)
    expect(await store.changeIfRevision(CHANNEL_TARGET, 1, { remove: true }, { ...guard, actorId: OTHER })).toBe(0)
    expect(await store.changeIfRevision(CHANNEL_TARGET, 1, { remove: true }, guard, Date.now() + 120_000)).toBe(0)
    expect(await store.changeIfRevision(CHANNEL_TARGET, 1, { remove: true }, guard)).toBe(1)
    expect(await store.getDestination(CHANNEL)).toBeNull()
    expect(await source.getRevision()).toBe(2)
  })

  it('changes language for one target or the whole guild through a language session', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    await seedDestination(env.DB, { ...THREAD_TARGET })
    await seedDestination(env.DB, { targetId: OTHER, guildId: OTHER })
    const id = 'c'.repeat(32)
    await session(id, 'lang', 3)
    const guard = { id, actorId: ACTOR, revision: 3, language: 'ja_jp' as const }
    await expect(store.changeLanguageFromSession(CHANNEL_TARGET, guard, 'en_us', 'guild')).rejects.toThrow(TypeError)
    expect(await store.changeLanguageFromSession(CHANNEL_TARGET, guard, 'en_us', 'target')).toBe(1)
    expect((await store.getDestination(CHANNEL))?.lang).toBe('en_us')
    expect((await store.getDestination(THREAD))?.lang).toBe('ja_jp')
    // The session now refers to an old revision.
    expect(await store.changeLanguageFromSession(CHANNEL_TARGET, guard, 'ja_jp', 'guild')).toBe(0)

    await env.DB.prepare("UPDATE destinations SET lang = 'ja_jp'").run()
    await env.DB.prepare('UPDATE discord_sessions SET revision = 4').run()
    expect(await store.changeLanguageFromSession(CHANNEL_TARGET, { ...guard, revision: 4 }, 'ja_jp', 'guild')).toBe(2)
    expect((await store.getDestination(OTHER))?.lang).toBe('ja_jp')
    expect(await source.getRevision()).toBe(5)
  })

  it('removes guild rows and exact targets with one revision increment per changed batch', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    await store.insertDestinationIfAbsent(THREAD_TARGET)
    await seedDestination(env.DB, { targetId: OTHER })
    expect(await store.removeDestinations([CHANNEL, CHANNEL])).toBe(1)
    expect(await store.getDestination(THREAD)).not.toBeNull()
    expect(await store.removeByGuildId(GUILD)).toBe(1)
    expect(await store.removeByGuildId(GUILD)).toBe(0)
    expect(await store.removeDestinations([])).toBe(0)
    expect(await source.loadSnapshot()).toMatchObject({ revision: 5, destinations: [{ targetId: OTHER }] })
  })

  it('clears webhooks by ID beyond the bound-parameter limit, and by guarded target', async () => {
    await seedDestination(env.DB, { ...CHANNEL_TARGET, webhook: HOOK })
    await seedDestination(env.DB, { ...THREAD_TARGET, webhook: HOOK })
    expect(await store.clearWebhooksByTargets([{ targetId: CHANNEL, expectedWebhookId: OTHER }])).toBe(0)
    expect(await store.clearWebhooksByTargets([{ targetId: CHANNEL, expectedWebhookId: WEBHOOK }])).toBe(1)
    const ids = [...Array.from({ length: 125 }, (_, i) => String(1000 + i)), WEBHOOK]
    expect(await store.clearWebhooksByIds(ids)).toBe(1)
    expect(await store.clearWebhooksByIds(ids)).toBe(0)
    for (const d of (await source.loadSnapshot()).destinations) expect(d.webhook).toBeNull()
    expect(await source.getRevision()).toBe(4)
  })
})

describe('D1 transaction atomicity and concurrency', () => {
  it('keeps changes() bound to the preceding statement, including no-op and multi-row writes', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    await store.insertDestinationIfAbsent(THREAD_TARGET)
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
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    await env.DB.prepare(`CREATE TRIGGER fail_revision AFTER UPDATE ON config_meta
      BEGIN SELECT RAISE(ABORT, 'synthetic revision failure'); END`).run()
    try {
      await expect(store.changeIfRevision(CHANNEL_TARGET, 1, { flags: FLAGS })).rejects.toBeInstanceOf(StorageError)
      await expect(store.insertDestinationIfAbsent(THREAD_TARGET)).rejects.toBeInstanceOf(StorageError)
      await expect(store.removeDestinations([CHANNEL])).rejects.toBeInstanceOf(StorageError)
      expect((await store.getDestination(CHANNEL))?.eewAlert).toBe(false)
      expect(await store.getDestination(THREAD)).toBeNull()
      expect(await source.getRevision()).toBe(1)
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_revision').run()
    }
  })

  it('rolls back earlier rows of a bulk mutation when a later row fails', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    await store.insertDestinationIfAbsent(THREAD_TARGET)
    await env.DB.prepare(`CREATE TRIGGER fail_destination BEFORE DELETE ON destinations
      WHEN OLD.target_id = '${THREAD}' BEGIN SELECT RAISE(ABORT, 'synthetic row failure'); END`).run()
    try {
      await expect(store.removeByGuildId(GUILD)).rejects.toBeInstanceOf(StorageError)
      expect((await source.loadSnapshot()).destinations).toHaveLength(2)
      expect(await source.getRevision()).toBe(2)
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_destination').run()
    }
  })

  it('does not expose webhook tokens in database exceptions', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    await lock()
    await env.DB.prepare(`CREATE TRIGGER fail_secret BEFORE UPDATE ON destinations
      BEGIN SELECT RAISE(ABORT, '${TOKEN}'); END`).run()
    try {
      const error = await store
        .changeIfRevision(CHANNEL_TARGET, 1, { webhook: HOOK, lockOwner: LOCK_OWNER })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(StorageError)
      expect(String(error)).not.toContain(TOKEN)
      expect(JSON.stringify(error)).not.toContain(TOKEN)
      expect((error as Error).cause).toBeUndefined()
      expect(await source.getRevision()).toBe(1)
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_secret').run()
    }
  })

  it('rejects revision overflow atomically instead of rounding the counter', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    await env.DB.prepare('UPDATE config_meta SET channels_revision = ? WHERE id = 1')
      .bind(Number.MAX_SAFE_INTEGER)
      .run()
    await expect(
      store.changeIfRevision(CHANNEL_TARGET, Number.MAX_SAFE_INTEGER, { flags: FLAGS }),
    ).rejects.toBeInstanceOf(StorageError)
    expect(await source.getRevision()).toBe(Number.MAX_SAFE_INTEGER)
    expect((await store.getDestination(CHANNEL))?.eewAlert).toBe(false)
  })

  it('serializes racing insert-if-absent requests into one insert and revision increment', async () => {
    const counts = await Promise.all(Array.from({ length: 20 }, () => store.insertDestinationIfAbsent(CHANNEL_TARGET)))
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
    expect(await source.getRevision()).toBe(1)
  })

  it('lets exactly one of many concurrent compare-and-swap writers win', async () => {
    await store.insertDestinationIfAbsent(CHANNEL_TARGET)
    const writers = Array.from({ length: 40 }, () => new D1DestinationStore(env.DB))
    const counts = await Promise.all(
      writers.map((writer, i) => writer.changeIfRevision(CHANNEL_TARGET, 1, { minIntensity: (i % 9) as Intensity })),
    )
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
    expect(await source.getRevision()).toBe(2)
  })

  it('reads coherent snapshots during writes and converges after updates stop', async () => {
    const observations = []
    const writers = []
    for (let i = 0; i < 25; i++) {
      const id = String(100 + i)
      writers.push(
        new D1DestinationStore(env.DB).insertDestinationIfAbsent({
          targetId: id,
          channelId: id,
          guildId: GUILD,
          threadId: null,
        }),
      )
      observations.push(source.loadSnapshot())
    }
    const snapshots = await Promise.all(observations)
    await Promise.all(writers)
    for (const snapshot of snapshots) expect(snapshot.revision).toBe(snapshot.destinations.length)
    const latest = await source.loadSnapshot()
    expect(latest.revision).toBe(25)
    expect(latest.destinations).toHaveLength(25)
  })
})

describe('ID and webhook validation', () => {
  it.each([GUILD, CHANNEL, THREAD, '1', '18446744073709551615'])('accepts exact decimal Snowflake %s', (id) => {
    expect(() => assertSnowflake(id)).not.toThrow()
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
  ])('rejects invalid/non-string IDs (%s) before D1 binding', async (id) => {
    expect(() => assertSnowflake(id)).toThrow(TypeError)
    await expect(store.getDestination(id as string)).rejects.toThrow(TypeError)
    expect(await source.getRevision()).toBe(0)
  })

  it('builds webhook URLs on the fixed Discord origin', () => {
    expect(webhookUrl(HOOK, null)).toBe(`https://discord.com/api/webhooks/${WEBHOOK}/${TOKEN}`)
    expect(webhookUrl(HOOK, THREAD)).toBe(`https://discord.com/api/webhooks/${WEBHOOK}/${TOKEN}?thread_id=${THREAD}`)
  })

  it.each(['short', `${TOKEN}/../x`, `${TOKEN}?q`, `${TOKEN}#f`, `${TOKEN}\n`, 'x'.repeat(257)])(
    'rejects malformed webhook token %j without echoing it',
    (token) => {
      expect(() => webhookUrl({ id: WEBHOOK, token }, null)).toThrow(/^Invalid Discord webhook token$/)
    },
  )
})
