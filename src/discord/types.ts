import type { Destination } from '../db/destination-types'

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

export type Target = { targetId: string; guildId: string; channelId: string; threadId: string | null }
export type Session = {
  id: string
  actor_id: string
  guild_id: string
  target_id: string
  channel_id: string
  revision: number
  kind: 'setup' | 'unregister'
  expires_at: number
}
export type VersionedDestination = { revision: number; destination: Destination | null }
export type ComponentAction = 'b' | 'm' | 'i' | 'c' | 'x'
export type Message = { content: string; components: unknown[]; allowed_mentions: { parse: never[] } }

export function message(content: string, components: unknown[] = []): Message {
  return { content, components, allowed_mentions: { parse: [] } }
}

/** Only static, secret-free messages may cross the REST/storage boundary. */
export class InteractionError extends Error {}
