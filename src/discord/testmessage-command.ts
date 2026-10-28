import { D1DestinationStore } from '../db/d1-destination-store'
import type { Bindings } from '../env'
import { testMessageText } from '../i18n/testmessage'
import { deliverTestMessage, deliveryPlan, DeliveryError } from './testmessage-delivery'
import { TestMessageState } from './testmessage-state'
import { HttpFailure } from './http'
import { DiscordRest, DiscordRestError } from './rest'
import { message, sameTarget, type Interaction } from './types'

export function isTestMessageInteraction(i: Interaction): boolean {
  return i.type === 2 && i.data?.name === 'testmessage'
}

export async function processTestMessage(i: Interaction, env: Bindings): Promise<void> {
  const deadline = Date.now() + 20_000
  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN!, deadline)
  let language = 'ja_jp'
  let result: string
  try {
    if (!env.DB || !env.DISCORD_BOT_TOKEN) throw new DeliveryError('configuration')
    await rest.verifyApplication(env.DISCORD_APPLICATION_ID!)
    const { target, parent } = await rest.target(i)
    const destination = await new D1DestinationStore(env.DB).getDestination(target.targetId)
    if (destination && !sameTarget(destination, target)) throw new DeliveryError('configuration')
    language = destination?.lang ?? 'ja_jp'
    const claim = await new TestMessageState(env.DB).claim(i.id!, i.member!.user!.id!, target)
    if (claim === 'duplicate') return
    if (claim === 'limited') throw new DeliveryError('ratelimit')
    const plan = deliveryPlan(env, destination, target)
    if (plan.route === 'nowebhook') {
      try { await rest.botPermissions(env.DISCORD_APPLICATION_ID!, target, parent, i.app_permissions) }
      catch (error) {
        if (error instanceof DiscordRestError) throw error
        throw new DeliveryError('missingperms')
      }
    }
    await deliverTestMessage(plan, env, target, {
      embeds: [{ title: testMessageText(language, 'title'), description: testMessageText(language, plan.route), color: 7506394 }],
      allowed_mentions: { parse: [] },
    }, deadline)
    result = testMessageText(language, `success.${plan.route}`)
  } catch (error) {
    const code = error instanceof DeliveryError ? error.code : error instanceof HttpFailure
      ? error.kind === 'timeout' || error.kind === 'connection' ? 'uncertain' : 'unknown'
      : error instanceof DiscordRestError ? error.status === 403 ? 'missingperms'
        : error.status === 429 ? 'ratelimit' : error.status >= 500 ? 'unavailable' : 'unknown' : 'unknown'
    result = `${testMessageText(language, 'error.title')}\n${testMessageText(language, `error.${code}`)}`
  }
  // Failure to edit an ACK never repeats the delivery or changes its known result.
  try { await rest.edit(i, message(result)) }
  catch { console.warn('Discord testmessage response unavailable', { interactionId: i.id }) }
}
