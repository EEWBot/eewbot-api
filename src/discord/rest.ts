import { assertSnowflake } from '../db/destination-validation'
import { coreText } from '../i18n/core'
import { ja } from '../i18n/ja'
import {
  DELIVERABLE_CHANNEL_TYPES,
  Permission,
  REST_DEADLINE_MS,
  THREAD_CHANNEL_TYPES,
  THREAD_PARENT_CHANNEL_TYPES,
} from './constants'
import { boundedRequest } from './http'
import { hasPermission, parsePermissions } from './permissions'
import { type GuildInteraction, InteractionError, type InteractionMessage, type Target } from './types'

const ROOT = 'https://discord.com/api/v10'

/** Role/member permission overwrite types. */
const OVERWRITE_ROLE = 0
const OVERWRITE_MEMBER = 1
/** Incoming webhook type. */
const INCOMING_WEBHOOK = 1

type Overwrite = { id: string; type: number; allow: string; deny: string }
export type Channel = {
  id: string
  guild_id?: string
  type: number
  parent_id?: string
  permission_overwrites?: Overwrite[]
}
export type Webhook = {
  id: string
  token?: string
  type: number
  channel_id?: string
  guild_id?: string
  user?: { id: string }
}
/** A webhook owned by this application, with its token present. */
export type OwnedWebhook = Webhook & { token: string }

export class DiscordRestError extends InteractionError {
  override readonly name = 'DiscordRestError'

  /**
   * @param status HTTP status, or 0 for transport failures/timeouts.
   * @param ambiguous The request may have taken effect even though it failed.
   */
  constructor(
    readonly status: number,
    readonly ambiguous = false,
  ) {
    super(
      status === 429
        ? ja.discord.rateLimited
        : status === 403
          ? ja.discord.forbidden
          : status === 404
            ? ja.discord.notFound
            : ja.discord.unavailable,
    )
  }
}

export function isOwnWebhook(hook: Webhook, target: Target, applicationId: string): hook is OwnedWebhook {
  return (
    hook.type === INCOMING_WEBHOOK &&
    hook.channel_id === target.channelId &&
    hook.guild_id === target.guildId &&
    hook.user?.id === applicationId &&
    typeof hook.token === 'string'
  )
}

export class DiscordRest {
  constructor(
    private readonly botToken: string,
    private readonly deadline = Date.now() + REST_DEADLINE_MS,
  ) {}

  private async request<T>(path: string, method = 'GET', body?: unknown, bot = true): Promise<T> {
    if (Date.now() >= this.deadline) throw new DiscordRestError(0)
    try {
      // Every path is built here from validated IDs. Never fetch a stored webhook URL.
      const response = await boundedRequest(
        ROOT + path,
        {
          method,
          headers: { ...(bot ? { Authorization: `Bot ${this.botToken}` } : {}), 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        this.deadline,
      )
      if (response.status < 200 || response.status >= 300) {
        throw new DiscordRestError(response.status, method === 'POST' && response.status >= 500)
      }
      return response.status === 204 ? (undefined as T) : (JSON.parse(response.body) as T)
    } catch (error) {
      if (error instanceof DiscordRestError) throw error
      // Fetch exceptions can include token-bearing URLs. Discard them completely.
      throw new DiscordRestError(0, method === 'POST')
    }
  }

  /** Resolves the interaction channel to a delivery target, following threads to their parent. */
  async target(interaction: GuildInteraction): Promise<{ target: Target; channel: Channel; parent: Channel }> {
    const { channelId: targetId, guildId } = interaction
    const channel = await this.request<Channel>(`/channels/${targetId}`)
    if (channel.id !== targetId || channel.guild_id !== guildId)
      throw new InteractionError(ja.discord.channelUnverified)
    const thread = THREAD_CHANNEL_TYPES.includes(channel.type)
    if (!thread && !DELIVERABLE_CHANNEL_TYPES.includes(channel.type)) {
      throw new InteractionError(ja.discord.unsupportedChannel)
    }
    let parent = channel
    if (thread) {
      assertSnowflake(channel.parent_id)
      parent = await this.request<Channel>(`/channels/${channel.parent_id}`)
    }
    if (
      parent.guild_id !== guildId ||
      parent.id !== (thread ? channel.parent_id : targetId) ||
      !THREAD_PARENT_CHANNEL_TYPES.includes(parent.type)
    ) {
      throw new InteractionError(ja.discord.parentUnverified)
    }
    return {
      target: { targetId, guildId, channelId: parent.id, threadId: thread ? targetId : null },
      channel,
      parent,
    }
  }

  /**
   * Computes the bot's effective permissions in the parent channel (guild roles
   * plus channel overwrites) and requires view + send in the target.
   */
  async botPermissions(
    applicationId: string,
    target: Target,
    parent: Channel,
    appPermissions: bigint | undefined,
    language = 'ja_jp',
  ): Promise<bigint> {
    const [member, roles] = await Promise.all([
      this.request<{ user: { id: string }; roles: string[] }>(`/guilds/${target.guildId}/members/${applicationId}`),
      this.request<{ id: string; permissions: string }[]>(`/guilds/${target.guildId}/roles`),
    ])
    if (member.user.id !== applicationId) throw new InteractionError(ja.discord.applicationMismatch)
    const assigned = new Set([target.guildId, ...member.roles])
    let effective = roles
      .filter((role) => assigned.has(role.id))
      .reduce((value, role) => value | parsePermissions(role.permissions), 0n)
    if (!hasPermission(effective, Permission.ADMINISTRATOR)) {
      const overwrites = parent.permission_overwrites
      if (!Array.isArray(overwrites)) throw new InteractionError(ja.discord.botPermissionsUnverified)
      const apply = (value: bigint, overwrite: { allow: bigint; deny: bigint }) =>
        (value & ~overwrite.deny) | overwrite.allow
      const parse = (o: Overwrite) => ({ allow: parsePermissions(o.allow), deny: parsePermissions(o.deny) })
      const everyone = overwrites.find((o) => o.type === OVERWRITE_ROLE && o.id === target.guildId)
      if (everyone) effective = apply(effective, parse(everyone))
      const roleOverwrites = overwrites
        .filter((o) => o.type === OVERWRITE_ROLE && o.id !== target.guildId && assigned.has(o.id))
        .map(parse)
      effective = apply(effective, {
        allow: roleOverwrites.reduce((value, o) => value | o.allow, 0n),
        deny: roleOverwrites.reduce((value, o) => value | o.deny, 0n),
      })
      const own = overwrites.find((o) => o.type === OVERWRITE_MEMBER && o.id === member.user.id)
      if (own) effective = apply(effective, parse(own))
    }
    if (
      appPermissions === undefined ||
      !hasPermission(effective, Permission.VIEW_CHANNEL) ||
      !hasPermission(appPermissions, Permission.VIEW_CHANNEL)
    ) {
      throw new InteractionError(coreText(language, 'eewbot.scmd.setup.permserror.viewchannel'))
    }
    const send = target.threadId ? Permission.SEND_MESSAGES_IN_THREADS : Permission.SEND_MESSAGES
    if (!hasPermission(effective, send) || !hasPermission(appPermissions, send)) {
      throw new InteractionError(coreText(language, 'eewbot.scmd.setup.permserror.sendmessages'))
    }
    return effective
  }

  /** Guards against a bot token that belongs to a different application. */
  async verifyApplication(applicationId: string): Promise<void> {
    const application = await this.request<{ id: string }>('/oauth2/applications/@me')
    if (application.id !== applicationId) throw new InteractionError(ja.discord.applicationMismatch)
  }

  webhooks(channelId: string): Promise<Webhook[]> {
    assertSnowflake(channelId)
    return this.request(`/channels/${channelId}/webhooks`)
  }

  createWebhook(channelId: string, targetId: string): Promise<Webhook> {
    assertSnowflake(channelId)
    assertSnowflake(targetId)
    return this.request(`/channels/${channelId}/webhooks`, 'POST', { name: `EEWBot-${targetId}` })
  }

  async deleteWebhook(id: string): Promise<void> {
    assertSnowflake(id)
    try {
      await this.request(`/webhooks/${id}`, 'DELETE')
    } catch (error) {
      if (!(error instanceof DiscordRestError && error.status === 404)) throw error
    }
  }

  private interactionPath(interaction: GuildInteraction): string {
    return `/webhooks/${interaction.applicationId}/${encodeURIComponent(interaction.token)}`
  }

  /** A POST may already have succeeded when its response is lost. Never blindly retry it. */
  async followup(interaction: GuildInteraction, reply: InteractionMessage): Promise<void> {
    await this.request(`${this.interactionPath(interaction)}?wait=true`, 'POST', reply, false)
  }

  /** Edits @original; idempotent, so one retry on transport/5xx/429 failures is safe. */
  async edit(interaction: GuildInteraction, reply: InteractionMessage): Promise<void> {
    const path = `${this.interactionPath(interaction)}/messages/@original`
    try {
      await this.request(path, 'PATCH', reply, false)
    } catch (error) {
      const retryable =
        error instanceof DiscordRestError && (error.status === 0 || error.status >= 500 || error.status === 429)
      if (!retryable) throw error
      await this.request(path, 'PATCH', reply, false)
    }
  }
}
