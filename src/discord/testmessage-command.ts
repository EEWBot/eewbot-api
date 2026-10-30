import type { D1Database } from '@cloudflare/workers-types'
import { InteractionType } from 'discord-interactions'
import { D1DestinationStore } from '../db/d1-destination-store'
import { storage } from '../db/storage-error'
import type { Bindings } from '../env'
import type { LanguageCode } from '../i18n/languages'
import { type TestMessageKey, testMessageText } from '../i18n/testmessage'
import { log } from '../log'
import { EMBED_COLOR, Permission, TESTMESSAGE_COOLDOWN_MS } from './constants'
import { HttpFailure } from './http'
import { hasPermission } from './permissions'
import { DiscordRest, DiscordRestError } from './rest'
import { DeliveryError, deliverTestMessage, deliveryPlan } from './testmessage-delivery'
import { type GuildInteraction, type Interaction, message, sameTarget, targetOf } from './types'

/**
 * Takes the target's cooldown slot: succeeds unless another run started within
 * the cooldown. A single statement, so concurrent runs cannot both succeed.
 */
export async function claimTestMessage(db: D1Database, targetId: string, now = Date.now()): Promise<boolean> {
  const result = await storage(() =>
    db
      .prepare(
        `INSERT INTO testmessage_cooldowns (target_id, until) VALUES (?, ?)
         ON CONFLICT (target_id) DO UPDATE SET until = excluded.until WHERE testmessage_cooldowns.until <= ?`,
      )
      .bind(targetId, now + TESTMESSAGE_COOLDOWN_MS, now)
      .run(),
  )
  return result.meta.changes === 1
}

export function isTestMessageInteraction(i: Interaction): boolean {
  return i.type === InteractionType.APPLICATION_COMMAND && i.data?.name === 'testmessage'
}

function errorCode(error: unknown): TestMessageKey {
  if (error instanceof DeliveryError) return `error.${error.code}`
  // A timed-out or dropped POST may still have been delivered.
  if (error instanceof HttpFailure) return 'error.uncertain'
  if (error instanceof DiscordRestError) {
    if (error.status === 403) return 'error.missingperms'
    if (error.status === 429) return 'error.ratelimit'
    if (error.status >= 500) return 'error.unavailable'
  }
  return 'error.unknown'
}

/** /testmessage: sends one test message through the channel's configured route. Runs in waitUntil(). */
export async function processTestMessage(i: GuildInteraction, env: Bindings): Promise<void> {
  let language: LanguageCode = 'ja_jp'
  let result: string
  try {
    if (!env.DB) throw new DeliveryError('configuration')
    const target = targetOf(i)
    const destination = await new D1DestinationStore(env.DB).getDestination(target.targetId)
    if (destination && !sameTarget(destination, target)) throw new DeliveryError('configuration')
    language = destination?.lang ?? 'ja_jp'
    const plan = deliveryPlan(env, destination, target)
    if (plan.route === 'nowebhook') {
      const send = target.threadId ? Permission.SEND_MESSAGES_IN_THREADS : Permission.SEND_MESSAGES
      if (!env.DISCORD_BOT_TOKEN) throw new DeliveryError('configuration')
      if (!hasPermission(i.appPermissions, Permission.VIEW_CHANNEL | send)) throw new DeliveryError('missingperms')
    }
    if (!(await claimTestMessage(env.DB, target.targetId))) throw new DeliveryError('ratelimit')
    await deliverTestMessage(plan, env, target, {
      embeds: [
        {
          title: testMessageText(language, 'title'),
          description: testMessageText(language, plan.route),
          color: EMBED_COLOR,
        },
      ],
      allowed_mentions: { parse: [] },
    })
    result = testMessageText(language, `success.${plan.route}`)
  } catch (error) {
    result = `${testMessageText(language, 'error.title')}
${testMessageText(language, errorCode(error))}`
  }
  try {
    await new DiscordRest().edit(i, message(result))
  } catch {
    log.warn('discord_testmessage_response_failed', { interactionId: i.id })
  }
}
