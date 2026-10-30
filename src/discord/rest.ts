import { apiText } from '../i18n/api'
import { request } from './http'
import { type GuildInteraction, InteractionError, type InteractionMessage } from './types'

const ROOT = 'https://discord.com/api/v10'

export type Webhook = {
  id: string
  name?: string | null
  token?: string
  type: number
  channel_id?: string
  user?: { id: string }
}

export class DiscordRestError extends InteractionError {
  override readonly name = 'DiscordRestError'

  /** @param status HTTP status, or 0 for transport failures/timeouts. */
  constructor(
    readonly status: number,
    language = 'ja_jp',
  ) {
    const text = apiText(language).discord
    super(
      status === 429
        ? text.rateLimited
        : status === 403
          ? text.forbidden
          : status === 404
            ? text.notFound
            : text.unavailable,
    )
  }
}

export class DiscordRest {
  constructor(
    private readonly botToken = '',
    private readonly language = 'ja_jp',
  ) {}

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await request(ROOT + path, {
      method,
      headers: {
        ...(this.botToken ? { Authorization: `Bot ${this.botToken}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => {
      throw new DiscordRestError(0, this.language)
    })
    if (response.status < 200 || response.status >= 300) throw new DiscordRestError(response.status, this.language)
    return response.status === 204 ? (undefined as T) : (JSON.parse(response.body) as T)
  }

  webhooks(channelId: string): Promise<Webhook[]> {
    return this.request(`/channels/${channelId}/webhooks`)
  }

  createWebhook(channelId: string, name: string): Promise<Webhook> {
    return this.request(`/channels/${channelId}/webhooks`, 'POST', { name })
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request(`/webhooks/${id}`, 'DELETE')
  }

  private interactionPath(interaction: GuildInteraction): string {
    return `/webhooks/${interaction.applicationId}/${encodeURIComponent(interaction.token)}`
  }

  /** Not retried: a POST may already have succeeded when its response is lost. */
  async followup(interaction: GuildInteraction, reply: InteractionMessage): Promise<void> {
    await this.request(`${this.interactionPath(interaction)}?wait=true`, 'POST', reply)
  }

  /** Edits @original; idempotent, so one retry on transport/5xx/429 failures is safe. */
  async edit(interaction: GuildInteraction, reply: InteractionMessage): Promise<void> {
    const path = `${this.interactionPath(interaction)}/messages/@original`
    try {
      await this.request(path, 'PATCH', reply)
    } catch (error) {
      if (!(error instanceof DiscordRestError && (error.status === 0 || error.status >= 500 || error.status === 429)))
        throw error
      await this.request(path, 'PATCH', reply)
    }
  }
}
