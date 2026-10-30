import { InteractionType } from 'discord-interactions'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Bindings } from '../env'
import { displayLanguage, type LanguageCode } from '../i18n/languages'
import { quakeInfoText } from '../i18n/quakeinfo'
import { log } from '../log'
import { type QuakeSnapshot, QuakeStore } from '../quakeinfo/store'
import { DiscordRest } from './rest'
import type { GuildInteraction, Interaction, InteractionMessage } from './types'

/** Reports older than this carry a warning that they are not a current earthquake. */
const OLD_REPORT_MS = 24 * 60 * 60_000

export function isQuakeInfoInteraction(i: Interaction): boolean {
  return i.type === InteractionType.APPLICATION_COMMAND && i.data?.name === 'quakeinfo'
}

const discordTimestamp = (ms: number) => `<t:${Math.floor(ms / 1000)}:F>`

function heading(snapshot: QuakeSnapshot, language: LanguageCode, now: number): string {
  const t = quakeInfoText(language)
  const issued = snapshot.reportDateTime ?? snapshot.dateTime
  const issuedMs = issued === null ? null : Date.parse(issued)
  const lines = [
    `${t.report}: ${issuedMs === null ? '—' : discordTimestamp(issuedMs)} · ${t.kinds[snapshot.infoTypePriority]}`,
    `${t.saved}: ${discordTimestamp(snapshot.updatedAt)}`,
  ]
  // The explicit report time stays meaningful even when the Java publisher is stopped.
  if (issuedMs === null || now - issuedMs > OLD_REPORT_MS) lines.push(t.old)
  return lines.join('\n')
}

/** /quakeinfo: posts the latest committed snapshot publicly. Runs in waitUntil(). */
export async function processQuakeInfo(i: GuildInteraction, env: Bindings): Promise<void> {
  // Interaction webhooks need no bot token.
  const rest = new DiscordRest()
  let language: LanguageCode = 'ja_jp'
  let original: InteractionMessage | undefined
  try {
    if (!env.DB) throw new Error('storage_unavailable')
    const destination = await new D1DestinationStore(env.DB).getDestination(i.channelId)
    if (destination && destination.guildId === i.guildId) language = displayLanguage(destination.lang).code
    const latest = await new QuakeStore(env.DB).latest(language)
    const [first, ...followups] = latest.messages
    if (!latest.snapshot || !first) {
      await rest.edit(i, { content: quakeInfoText(language).error, allowed_mentions: { parse: [] } })
      return
    }
    original = {
      content: heading(latest.snapshot, language, Date.now()),
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
    const content = original ? `${original.content}\n${t.partial}` : t.error
    try {
      await rest.edit(i, { ...original, content, allowed_mentions: { parse: [] } })
    } catch {
      log.warn('discord_quakeinfo_response_failed', { interactionId: i.id })
    }
  }
}
