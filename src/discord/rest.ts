import { assertSnowflake } from '../db/destination-validation'
import { InteractionError, type Interaction, type InteractionMessage, type Target } from './types'
import { boundedRequest } from './http'

const ROOT = 'https://discord.com/api/v10'
const ADMIN = 8n
const VIEW_CHANNEL = 1n << 10n
const SEND_MESSAGES = 1n << 11n
const SEND_IN_THREADS = 1n << 38n
export const MANAGE_WEBHOOKS = 1n << 29n

export function permissions(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value)) throw new InteractionError('権限情報を確認できません。')
  return BigInt(value)
}

export function hasPermission(value: bigint, required: bigint): boolean {
  return (value & ADMIN) !== 0n || (value & required) === required
}

type Overwrite = { id: string; type: number; allow: string; deny: string }
type Channel = { id: string; guild_id?: string; type: number; parent_id?: string; permission_overwrites?: Overwrite[] }
export type Webhook = { id: string; token?: string; type: number; channel_id?: string; guild_id?: string; user?: { id: string } }

export class DiscordRestError extends InteractionError {
  constructor(readonly status: number, readonly ambiguous = false) {
    super(status === 429 ? 'Discordの利用制限中です。しばらく待って再度実行してください。'
      : status === 403 ? 'BotのDiscord権限が不足しています。'
      : status === 404 ? 'Discordの対象が見つかりません。再度実行してください。'
      : 'Discordとの通信に失敗しました。しばらく待って再度実行してください。')
  }
}

export class DiscordRest {
  constructor(private readonly botToken: string, private readonly deadline = Date.now() + 20_000) {}

  private async request<T>(path: string, method = 'GET', body?: unknown, bot = true): Promise<T> {
    if (Date.now() >= this.deadline) throw new DiscordRestError(0)
    try {
      // Every path is built here from validated IDs. Never fetch a stored webhook URL.
      const response = await boundedRequest(ROOT + path, {
        method,
        headers: { ...(bot ? { Authorization: `Bot ${this.botToken}` } : {}), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, this.deadline)
      if (response.status < 200 || response.status >= 300) throw new DiscordRestError(response.status, method === 'POST' && response.status >= 500)
      return response.status === 204 ? undefined as T : JSON.parse(response.body) as T
    } catch (error) {
      if (error instanceof DiscordRestError) throw error
      // Fetch exceptions can include token-bearing URLs. Discard them completely.
      throw new DiscordRestError(0, method === 'POST')
    }
  }

  async target(interaction: Interaction): Promise<{ target: Target; channel: Channel; parent: Channel }> {
    const targetId = interaction.channel_id!
    const guildId = interaction.guild_id!
    assertSnowflake(targetId)
    assertSnowflake(guildId)
    const channel = await this.request<Channel>(`/channels/${targetId}`)
    if (channel.id !== targetId || channel.guild_id !== guildId) throw new InteractionError('チャンネルを確認できません。')
    const thread = [10, 11, 12].includes(channel.type)
    if (!thread && ![0, 5].includes(channel.type)) throw new InteractionError('このチャンネルの種類には対応していません。')
    if (thread) assertSnowflake(channel.parent_id)
    const parent = thread ? await this.request<Channel>(`/channels/${channel.parent_id}`) : channel
    if (parent.guild_id !== guildId || parent.id !== (thread ? channel.parent_id : targetId)
      || ![0, 5, 15, 16].includes(parent.type)) throw new InteractionError('親チャンネルを確認できません。')
    return { target: { targetId, guildId, channelId: parent.id, threadId: thread ? targetId : null }, channel, parent }
  }

  async botPermissions(applicationId: string, target: Target, parent: Channel, appPermissions: unknown): Promise<bigint> {
    const [member, roles] = await Promise.all([
      this.request<{ user: { id: string }; roles: string[] }>(`/guilds/${target.guildId}/members/${applicationId}`),
      this.request<{ id: string; permissions: string }[]>(`/guilds/${target.guildId}/roles`),
    ])
    if (member.user.id !== applicationId) {
      throw new InteractionError('BotのApplication設定が一致しません。')
    }
    const assigned = new Set([target.guildId, ...member.roles])
    let effective = roles.filter((role) => assigned.has(role.id)).reduce((v, role) => v | permissions(role.permissions), 0n)
    if (!hasPermission(effective, ADMIN)) {
      if (!Array.isArray(parent.permission_overwrites)) throw new InteractionError('Bot権限を確認できません。')
      const everyone = parent.permission_overwrites.find((o) => o.type === 0 && o.id === target.guildId)
      if (everyone) effective = (effective & ~permissions(everyone.deny)) | permissions(everyone.allow)
      const overrides = parent.permission_overwrites.filter((o) => o.type === 0 && o.id !== target.guildId && assigned.has(o.id))
      effective = (effective & ~overrides.reduce((v, o) => v | permissions(o.deny), 0n))
        | overrides.reduce((v, o) => v | permissions(o.allow), 0n)
      const own = parent.permission_overwrites.find((o) => o.type === 1 && o.id === member.user.id)
      if (own) effective = (effective & ~permissions(own.deny)) | permissions(own.allow)
    }
    const required = VIEW_CHANNEL | (target.threadId ? SEND_IN_THREADS : SEND_MESSAGES)
    if (!hasPermission(effective, required) || !hasPermission(permissions(appPermissions), required)) {
      throw new InteractionError('Botにチャンネルの閲覧・メッセージ送信権限が必要です。')
    }
    return effective
  }

  async verifyApplication(applicationId: string): Promise<void> {
    const application = await this.request<{ id: string }>('/oauth2/applications/@me')
    if (application.id !== applicationId) throw new InteractionError('BotのApplication設定が一致しません。')
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
    try { await this.request(`/webhooks/${id}`, 'DELETE') }
    catch (error) { if (!(error instanceof DiscordRestError && error.status === 404)) throw error }
  }

  private interactionPath(interaction: Interaction): string {
    assertSnowflake(interaction.application_id)
    if (typeof interaction.token !== 'string' || !/^[A-Za-z0-9._-]{1,2048}$/.test(interaction.token)) {
      throw new InteractionError('応答用の情報が無効です。')
    }
    return `/webhooks/${interaction.application_id}/${encodeURIComponent(interaction.token)}`
  }

  async followup(interaction: Interaction, reply: InteractionMessage): Promise<void> {
    // A POST may already have succeeded when its response is lost. Never blindly retry it.
    await this.request(this.interactionPath(interaction) + '?wait=true', 'POST', reply, false)
  }

  async edit(interaction: Interaction, reply: InteractionMessage): Promise<void> {
    const path = this.interactionPath(interaction) + '/messages/@original'
    try { await this.request(path, 'PATCH', reply, false) }
    catch (error) {
      if (!(error instanceof DiscordRestError) || (error.status > 0 && error.status < 500 && error.status !== 429)) throw error
      await this.request(path, 'PATCH', reply, false)
    }
  }
}
