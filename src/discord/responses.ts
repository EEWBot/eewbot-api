import { InteractionResponseFlags, InteractionResponseType } from 'discord-interactions'

const NO_MENTIONS = { parse: [] as never[] }

export type InteractionResponse = { type: InteractionResponseType; data?: Record<string, unknown> }

export function pong(): InteractionResponse {
  return { type: InteractionResponseType.PONG }
}

export function reply(data: Record<string, unknown>, { ephemeral = false } = {}): InteractionResponse {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      ...data,
      ...(ephemeral ? { flags: InteractionResponseFlags.EPHEMERAL } : {}),
      allowed_mentions: NO_MENTIONS,
    },
  }
}

export function ephemeral(content: string): InteractionResponse {
  return reply({ content }, { ephemeral: true })
}

/** "Thinking…" acknowledgement; the result is sent later by editing @original. */
export function deferred({ ephemeral = false } = {}): InteractionResponse {
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { ...(ephemeral ? { flags: InteractionResponseFlags.EPHEMERAL } : {}), allowed_mentions: NO_MENTIONS },
  }
}

/** Component acknowledgement; @original (the menu message) is edited in place. */
export function deferredUpdate(): InteractionResponse {
  return { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE }
}

export function emptyAutocomplete(): InteractionResponse {
  return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } }
}
