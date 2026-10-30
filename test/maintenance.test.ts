import { applyD1Migrations, createScheduledController } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { purgeExpired } from '../src/maintenance'
import { resetDb } from './support/fixtures'

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS))
beforeEach(() => resetDb(env.DB))

async function seed() {
  const session = (id: string, expiresAt: number) =>
    env.DB.prepare(
      `INSERT INTO discord_sessions (id, kind, actor_id, guild_id, target_id, channel_id, revision, expires_at)
       VALUES (?, 'setup', '1', '1', '1', '1', 0, ?)`,
    ).bind(id, expiresAt)
  await env.DB.batch([
    env.DB.prepare('INSERT INTO interaction_receipts VALUES (?, ?)').bind('1', NOW - 1),
    env.DB.prepare('INSERT INTO interaction_receipts VALUES (?, ?)').bind('2', NOW + 1),
    session('expired', NOW),
    session('live', NOW + 1),
    env.DB.prepare('INSERT INTO discord_setup_locks VALUES (?, ?, ?)').bind('1', 'a', NOW - 1),
    env.DB.prepare('INSERT INTO discord_setup_locks VALUES (?, ?, ?)').bind('2', 'b', NOW + 1),
    env.DB.prepare("INSERT INTO discord_testmessage_runs VALUES ('1', '1', '1', '1', ?)").bind(NOW - 600_000),
    env.DB.prepare("INSERT INTO discord_testmessage_runs VALUES ('2', '1', '1', '1', ?)").bind(NOW - 599_999),
  ])
}

async function ids(table: string, column: string) {
  const { results } = await env.DB.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`).all<{
    id: string
  }>()
  return results.map((row) => row.id)
}

async function expectPurged() {
  expect(await ids('interaction_receipts', 'interaction_id')).toEqual(['2'])
  expect(await ids('discord_sessions', 'id')).toEqual(['live'])
  expect(await ids('discord_setup_locks', 'channel_id')).toEqual(['2'])
  expect(await ids('discord_testmessage_runs', 'interaction_id')).toEqual(['2'])
}

describe('scheduled maintenance', () => {
  it('purges only expired ephemeral rows', async () => {
    await seed()
    await purgeExpired(env.DB, NOW)
    await expectPurged()
  })

  it('runs from the Worker scheduled handler using the scheduled time', async () => {
    await seed()
    await worker.scheduled(createScheduledController({ scheduledTime: NOW, cron: '*/10 * * * *' }), env)
    await expectPurged()
  })

  it('logs a sanitized failure and rethrows so the invocation is marked failed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const DB = { batch: () => Promise.reject(new Error('SELECT secret-token')) } as unknown as D1Database
    await expect(
      worker.scheduled(createScheduledController({ scheduledTime: NOW, cron: '*/10 * * * *' }), { DB }),
    ).rejects.toThrow()
    expect(String(log.mock.calls)).toContain('maintenance_failed')
    expect(String(log.mock.calls)).not.toContain('secret-token')
  })
})
