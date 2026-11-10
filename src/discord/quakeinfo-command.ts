import { InteractionType } from 'discord-interactions'
import type { Bindings } from '../env'
import type { LanguageCode } from '../i18n/languages'
import { quakeInfoText } from '../i18n/quakeinfo'
import { log } from '../log'
import { QuakeStore } from '../quakeinfo/store'
import { DiscordRest } from './rest'
import type { AuthorizedInteraction, Interaction, InteractionMessage } from './types'

export function isQuakeInfoInteraction(i: Interaction): boolean {
  return i.type === InteractionType.APPLICATION_COMMAND && i.data?.name === 'quakeinfo'
}

/** /quakeinfo: posts the latest committed snapshot publicly. Runs in waitUntil(). */
export async function processQuakeInfo(i: AuthorizedInteraction, env: Bindings): Promise<void> {
  // Interaction webhooks need no bot token.
  const rest = new DiscordRest()
  let language: LanguageCode = 'ja_jp'
  let original: InteractionMessage | undefined
  try {
    if (!env.DB) throw new Error('storage_unavailable')
    const latest = await new QuakeStore(env.DB).latestForDestination(i.channelId, i.guildId)
    language = latest.lang
    const [first, ...followups] = latest.messages
    if (!latest.snapshot || !first) {
      await rest.edit(i, { content: quakeInfoText(language).error, allowed_mentions: { parse: [] } })
      return
    }
    original = {
      embeds: first.embeds,
      allowed_mentions: { parse: [] },
    }
    await rest.edit(i, original)
    for (const message of followups) {
      await rest.followup(i, { embeds: message.embeds, allowed_mentions: { parse: [] } })
    }
  } catch {
    // Keep the first page when a later POST fails; never restart the send loop.
    const t = quakeInfoText(language)
    const content = original ? t.partial : t.error
    try {
      await rest.edit(i, { ...original, content, allowed_mentions: { parse: [] } })
    } catch {
      log.warn('discord_quakeinfo_response_failed', { interactionId: i.id })
    }
  }
}
