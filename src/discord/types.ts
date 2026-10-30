import type { InteractionType } from 'discord-interactions'
import type { Destination, DestinationTarget, Snowflake } from '../db/destination-types'

/** The subset of a signed Discord interaction payload this Worker reads. Untrusted shape. */
export type Interaction = {
  type: number
  id?: string
  application_id?: string
  token?: string
  guild_id?: string
  channel_id?: string
  context?: number
  authorizing_integration_owners?: Record<string, string>
  app_permissions?: string
  member?: { permissions?: string; user?: { id?: string } }
  data?: { name?: unknown; custom_id?: unknown; component_type?: unknown; values?: unknown; options?: unknown }
}

/**
 * An interaction that passed common authorization: a Guild Install command or
 * component of this application, run inside a guild, with validated identifiers.
 */
export type GuildInteraction = {
  readonly type: InteractionType.APPLICATION_COMMAND | InteractionType.MESSAGE_COMPONENT
  readonly id: Snowflake
  readonly applicationId: Snowflake
  readonly token: string
  readonly guildId: Snowflake
  readonly channelId: Snowflake
  readonly actorId: Snowflake
  readonly memberPermissions: bigint
  /** Undefined when Discord omitted it; never trusted alone for bot permissions. */
  readonly appPermissions: bigint | undefined
  readonly commandName: string | undefined
  readonly customId: string | undefined
  readonly componentType: unknown
  readonly values: unknown
}

export type Target = DestinationTarget

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

/** A user-facing failure. Only static, secret-free text may be used as its message. */
export class InteractionError extends Error {
  override readonly name: string = 'InteractionError'
}
