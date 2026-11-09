import { InteractionResponseFlags, InteractionType, MessageComponentTypes } from 'discord-interactions'
import type { Bindings } from '../env'
import { interactionLanguage } from '../i18n/discord'
import { log } from '../log'
import { DiscordRest } from './rest'
import { type AuthorizedInteraction, type Interaction, InteractionError } from './types'

/** Shared with Core's ImageRefreshButton; the interaction token targets the clicked message. */
export const IMAGE_REFRESH_CUSTOM_ID = 'eewimage:refresh'

export function isImageRefreshInteraction(i: Interaction): boolean {
  return (
    i.type === InteractionType.MESSAGE_COMPONENT &&
    i.data?.component_type === MessageComponentTypes.BUTTON &&
    i.data.custom_id === IMAGE_REFRESH_CUSTOM_ID
  )
}

/** Keep content, embeds and attachments unchanged; remove only the recovery button. */
export async function processImageRefresh(i: AuthorizedInteraction, _env: Bindings): Promise<void> {
  const rest = new DiscordRest('', interactionLanguage(i.locale))
  try {
    await rest.edit(i, { components: [] })
  } catch (error) {
    log.warn('discord_image_refresh_failed', { interactionId: i.id })
    if (!(error instanceof InteractionError)) return
    try {
      await rest.followup(i, {
        content: error.message,
        flags: InteractionResponseFlags.EPHEMERAL,
        allowed_mentions: { parse: [] },
      })
    } catch {
      log.warn('discord_image_refresh_response_failed', { interactionId: i.id })
    }
  }
}
