import type { D1Database } from '@cloudflare/workers-types'
import { InteractionType } from 'discord-interactions'
import { D1DestinationStore } from '../db/d1-destination-store'
import { storage } from '../db/storage-error'
import type { Bindings } from '../env'
import type { LanguageCode } from '../i18n/languages'
import { type TestMessageKey, testMessageText } from '../i18n/testmessage'
import { log } from '../log'
import { EMBED_COLOR, REST_DEADLINE_MS } from './constants'
import { HttpFailure } from './http'
import { receiptInsert } from './receipts'
import { DiscordRest, DiscordRestError } from './rest'
import { DeliveryError, deliverTestMessage, deliveryPlan } from './testmessage-delivery'
import { type GuildInteraction, type Interaction, message, sameTarget, type Target } from './types'

/** Rate limits: per target, per actor, and per guild within a window. */
export const TESTMESSAGE_LIMITS = {
  targetIntervalMs: 30_000,
  actorIntervalMs: 60_000,
  guildWindowMs: 600_000,
  guildMaxRuns: 10,
} as const

export function isTestMessageInteraction(i: Interaction): boolean {
  return i.type === InteractionType.APPLICATION_COMMAND && i.data?.name === 'testmessage'
}

/**
 * Claims the interaction and a rate-limit slot in one serialized D1 transaction.
 * `changes()` in the second statement refers to the receipt INSERT before it.
 */
export async function claimTestMessage(
  db: D1Database,
  interactionId: string,
  actorId: string,
  target: Target,
  now = Date.now(),
): Promise<'granted' | 'duplicate' | 'limited'> {
  const limits = TESTMESSAGE_LIMITS
  const [receipt, grant] = await storage(() =>
    db.batch([
      receiptInsert(db, interactionId, now),
      db
        .prepare(
          `INSERT INTO discord_testmessage_runs (interaction_id, actor_id, target_id, guild_id, issued_at)
           SELECT ?, ?, ?, ?, ? WHERE changes() = 1
           AND NOT EXISTS (SELECT 1 FROM discord_testmessage_runs WHERE target_id = ? AND issued_at > ?)
           AND NOT EXISTS (SELECT 1 FROM discord_testmessage_runs WHERE actor_id = ? AND issued_at > ?)
           AND (SELECT count(*) FROM discord_testmessage_runs WHERE guild_id = ? AND issued_at > ?) < ?`,
        )
        .bind(
          interactionId,
          actorId,
          target.targetId,
          target.guildId,
          now,
          target.targetId,
          now - limits.targetIntervalMs,
          actorId,
          now - limits.actorIntervalMs,
          target.guildId,
          now - limits.guildWindowMs,
          limits.guildMaxRuns,
        ),
    ]),
  )
  if (receipt?.meta.changes !== 1) return 'duplicate'
  return grant?.meta.changes === 1 ? 'granted' : 'limited'
}

function errorCode(error: unknown): TestMessageKey {
  if (error instanceof DeliveryError) return `error.${error.code}`
  // A timed-out or dropped POST may still have been delivered.
  if (error instanceof HttpFailure) return error.kind === 'oversized' ? 'error.unknown' : 'error.uncertain'
  if (error instanceof DiscordRestError) {
    if (error.status === 403) return 'error.missingperms'
    if (error.status === 429) return 'error.ratelimit'
    if (error.status >= 500) return 'error.unavailable'
  }
  return 'error.unknown'
}

/** /testmessage: sends one test message through the channel's configured route. Runs in waitUntil(). */
export async function processTestMessage(i: GuildInteraction, env: Bindings): Promise<void> {
  const deadline = Date.now() + REST_DEADLINE_MS
  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN ?? '', deadline)
  let language: LanguageCode = 'ja_jp'
  let result: string
  try {
    const { DB, DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN } = env
    if (!DB || !DISCORD_APPLICATION_ID || !DISCORD_BOT_TOKEN) throw new DeliveryError('configuration')
    await rest.verifyApplication(DISCORD_APPLICATION_ID)
    const { target, parent } = await rest.target(i)
    const destination = await new D1DestinationStore(DB).getDestination(target.targetId)
    if (destination && !sameTarget(destination, target)) throw new DeliveryError('configuration')
    language = destination?.lang ?? 'ja_jp'
    const claim = await claimTestMessage(DB, i.id, i.actorId, target)
    if (claim === 'duplicate') return
    if (claim === 'limited') throw new DeliveryError('ratelimit')
    const plan = deliveryPlan(env, destination, target)
    if (plan.route === 'nowebhook') {
      try {
        await rest.botPermissions(DISCORD_APPLICATION_ID, target, parent, i.appPermissions)
      } catch (error) {
        if (error instanceof DiscordRestError) throw error
        throw new DeliveryError('missingperms')
      }
    }
    await deliverTestMessage(
      plan,
      env,
      target,
      {
        embeds: [
          {
            title: testMessageText(language, 'title'),
            description: testMessageText(language, plan.route),
            color: EMBED_COLOR,
          },
        ],
        allowed_mentions: { parse: [] },
      },
      deadline,
    )
    result = testMessageText(language, `success.${plan.route}`)
  } catch (error) {
    result = `${testMessageText(language, 'error.title')}\n${testMessageText(language, errorCode(error))}`
  }
  // Failure to edit the ACK never repeats the delivery or changes its known result.
  try {
    await rest.edit(i, message(result))
  } catch {
    log.warn('discord_testmessage_response_failed', { interactionId: i.id })
  }
}
