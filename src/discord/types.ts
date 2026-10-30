import type { InteractionType } from 'discord-interactions'
import type { Destination, DestinationTarget, Snowflake } from '../db/destination-types'
import { apiText } from '../i18n/api'
import { DELIVERABLE_CHANNEL_TYPES, THREAD_CHANNEL_TYPES } from './constants'

/** The subset of a signed Discord interaction payload this Worker reads. */
export type Interaction = {
  type: number
  id?: string
  application_id?: string
  token?: string
  guild_id?: string
  channel_id?: string
  channel?: { type?: number; parent_id?: string | null }
  app_permissions?: string
  member?: { permissions?: string; user?: { id?: string } }
  data?: { name?: unknown; custom_id?: unknown; component_type?: unknown; values?: unknown }
}

/** A command or component of this application, run inside a guild. */
export type GuildInteraction = {
  readonly type: InteractionType.APPLICATION_COMMAND | InteractionType.MESSAGE_COMPONENT
  readonly id: Snowflake
  readonly applicationId: Snowflake
  readonly token: string
  readonly guildId: Snowflake
  readonly channelId: Snowflake
  readonly channelType: number | undefined
  readonly parentId: Snowflake | null
  readonly actorId: Snowflake
  readonly memberPermissions: bigint
  /** The bot's permissions in the interaction channel, computed by Discord. */
  readonly appPermissions: bigint
  readonly commandName: string | undefined
  readonly customId: string | undefined
  readonly componentType: unknown
  readonly values: unknown
}

export type Target = DestinationTarget

/** A user-facing failure. Only static, secret-free text may be used as its message. */
export class InteractionError extends Error {
  override readonly name: string = 'InteractionError'
}

/** The delivery target of the interaction channel: the thread itself, under its parent channel. */
export function targetOf(i: GuildInteraction, language = 'ja_jp'): Target {
  const type = i.channelType ?? -1
  if (THREAD_CHANNEL_TYPES.includes(type) && i.parentId !== null) {
    return { targetId: i.channelId, guildId: i.guildId, channelId: i.parentId, threadId: i.channelId }
  }
  if (DELIVERABLE_CHANNEL_TYPES.includes(type)) {
    return { targetId: i.channelId, guildId: i.guildId, channelId: i.channelId, threadId: null }
  }
  throw new InteractionError(apiText(language).discord.unsupportedChannel)
}

export type Message = { content: string; components: unknown[]; allowed_mentions: { parse: never[] } }
export type InteractionMessage = {
  content?: string
  components?: unknown[]
  embeds?: unknown[]
  allowed_mentions: { parse: never[] }
}

export function message(content: string, components: unknown[] = []): Message {
  return { content, components, allowed_mentions: { parse: [] } }
}

export function sameTarget(d: Destination, target: Target): boolean {
  return (
    d.targetId === target.targetId &&
    d.guildId === target.guildId &&
    d.channelId === target.channelId &&
    d.threadId === target.threadId
  )
}
