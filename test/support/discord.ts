import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, vi } from 'vitest'
import type { Interaction } from '../../src/discord/types'
import type { Bindings } from '../../src/env'
import { app } from '../../src/index'

export const APP = '1234567890123456780'
export const GUILD = '1234567890123456789'
export const CHANNEL = '1234567890123456790'
export const THREAD = '1234567890123456791'
export const ACTOR = '1234567890123456793'
export const BOT_TOKEN = 'synthetic-bot-secret'
export const HOOK_TOKEN = 'synthetic-webhook-secret-0123456789'
/** View, send, manage webhooks, send in threads. */
export const BOT_PERMS = (1024n | 2048n | (1n << 29n) | (1n << 38n)).toString()
export const MANAGE_GUILD = '32'

export type Reply = {
  content?: string
  embeds?: unknown[]
  components?: { components: { custom_id: string; options?: { value: string; default: boolean }[] }[] }[]
  allowed_mentions: { parse: unknown[] }
}
export type Call = { url: URL; method: string; headers: Headers; body: unknown }
type Handler = (call: Call) => Response | Promise<Response>

const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
export const publicKey = hex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('')
}

export function bindings(overrides: Partial<Bindings> = {}): Bindings {
  return {
    DB: env.DB,
    DISCORD_PUBLIC_KEY: publicKey,
    DISCORD_COMMANDS_ENABLED: 'true',
    DISCORD_APPLICATION_ID: APP,
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    ...overrides,
  }
}

let sequence = 0

/** A guild command in a text channel, by a member with Manage Guild. */
export function command(name: string, overrides: Partial<Interaction> = {}): Interaction {
  sequence++
  return {
    type: 2,
    id: String(1234567890123460000n + BigInt(sequence)),
    application_id: APP,
    guild_id: GUILD,
    channel_id: CHANNEL,
    channel: { type: 0 },
    app_permissions: BOT_PERMS,
    member: { permissions: MANAGE_GUILD, user: { id: ACTOR } },
    token: `synthetic-interaction-${sequence}`,
    data: { name },
    ...overrides,
  }
}

/** The same context in a public thread under CHANNEL. */
export const inThread = { channel_id: THREAD, channel: { type: 11, parent_id: CHANNEL } }

export function component(customId: string, values?: string[], overrides: Partial<Interaction> = {}): Interaction {
  return command('', {
    type: 3,
    data: { custom_id: customId, component_type: values ? 3 : 2, ...(values ? { values } : {}) },
    ...overrides,
  })
}

/**
 * Fetch mock: records every call and answers @original edits. Other requests
 * go to `routes` keyed by "METHOD /path" (path relative to /api/v10).
 */
export class DiscordMock {
  calls: Call[] = []
  replies = new Map<string, Reply>()
  routes = new Map<string, Handler>()

  install(): this {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const call = {
          url,
          method,
          headers: new Headers(init?.headers),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        }
        this.calls.push(call)
        const path = url.pathname.replace('/api/v10', '')
        if (method === 'PATCH' && path.endsWith('/messages/@original')) {
          this.replies.set(decodeURIComponent(path.split('/')[3] ?? ''), call.body as Reply)
          return Response.json({})
        }
        const handler =
          this.routes.get(`${method} ${path}`) ?? this.routes.get(`${method} ${url.origin}${url.pathname}`)
        if (!handler) throw new Error(`Unexpected request ${method} ${path}`)
        return handler(call)
      }),
    )
    return this
  }

  /** Requests other than @original edits. */
  get requests(): Call[] {
    return this.calls.filter((c) => !(c.method === 'PATCH' && c.url.pathname.endsWith('/messages/@original')))
  }
}

export type Ack = { type: number; data?: { flags?: number; content?: string; embeds?: unknown[] } }

/** Signs and posts an interaction, waits for background work, and returns the ACK and @original edit. */
export async function execute(
  payload: Interaction,
  mock: DiscordMock,
  settings: Bindings = bindings(),
): Promise<{ ack: Ack; reply: Reply | undefined }> {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = hex(
    new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body))),
  )
  const ctx = createExecutionContext()
  const response = await app.fetch(
    new Request('https://local/interactions', {
      method: 'POST',
      body,
      headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
    }),
    settings,
    ctx,
  )
  expect(response.status).toBe(200)
  const ack = (await response.json()) as Ack
  await waitOnExecutionContext(ctx)
  return { ack, reply: mock.replies.get(payload.token ?? '') }
}
