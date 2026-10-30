import type { Destination } from '../db/destination-types'
import { webhookUrl } from '../db/destination-validation'
import type { Bindings } from '../env'
import { request as send } from './http'
import type { Target } from './types'

export type DeliveryRoute = 'webhook' | 'webhooksender' | 'nowebhook'
export type TestMessageBody = {
  embeds: { title: string; description: string; color: number }[]
  allowed_mentions: { parse: never[] }
}
export type DeliveryErrorCode =
  | 'configuration'
  | 'missingperms'
  | 'ratelimit'
  | 'unknownwebhook'
  | 'unknown'
  | 'unavailable'

export class DeliveryError extends Error {
  override readonly name = 'DeliveryError'

  constructor(readonly code: DeliveryErrorCode) {
    super(code)
  }
}

type Sender = { endpoint: string; access: { clientId: string; clientSecret: string } | null; authToken: string }
export type DeliveryPlan =
  | { route: 'nowebhook'; webhook: null; sender: null }
  | { route: 'webhook'; webhook: string; sender: null }
  | { route: 'webhooksender'; webhook: string; sender: Sender }

const HEADER_VALUE = /^[\x21-\x7e]{1,4096}$/
const isHeaderValue = (v: unknown): v is string => typeof v === 'string' && HEADER_VALUE.test(v)

/**
 * The optional Webhook Sender: an HTTP(S) origin with a bearer token, plus an
 * optional (HTTPS-only) Cloudflare Access service token pair. Independent of
 * the internal API's Access credentials.
 */
export function senderConfiguration(env: Bindings): Sender | null {
  if (!env.WEBHOOK_SENDER_URL) return null
  try {
    const url = new URL(env.WEBHOOK_SENDER_URL)
    const http = url.protocol === 'http:'
    if (
      (!http && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      ![url.origin, `${url.origin}/`].includes(env.WEBHOOK_SENDER_URL)
    ) {
      throw new Error()
    }
    const {
      WEBHOOK_SENDER_ACCESS_CLIENT_ID: clientId,
      WEBHOOK_SENDER_ACCESS_CLIENT_SECRET: clientSecret,
      WEBHOOK_SENDER_AUTH_TOKEN: authToken,
    } = env
    if (!isHeaderValue(authToken)) throw new Error()
    const endpoint = `${url.origin}/api/send`
    if (!clientId && !clientSecret) return { endpoint, access: null, authToken }
    if (http || !isHeaderValue(clientId) || !isHeaderValue(clientSecret)) throw new Error()
    return { endpoint, access: { clientId, clientSecret }, authToken }
  } catch {
    throw new DeliveryError('configuration')
  }
}

export function deliveryPlan(env: Bindings, destination: Destination | null, target: Target): DeliveryPlan {
  if (!destination?.webhook) return { route: 'nowebhook', webhook: null, sender: null }
  let webhook: string
  try {
    webhook = webhookUrl(destination.webhook, target.threadId)
  } catch {
    throw new DeliveryError('configuration')
  }
  const sender = senderConfiguration(env)
  return sender ? { route: 'webhooksender', webhook, sender } : { route: 'webhook', webhook, sender: null }
}

function request(
  plan: DeliveryPlan,
  env: Bindings,
  target: Target,
  body: TestMessageBody,
): { url: string; headers: Record<string, string>; body: unknown } {
  const json = { 'Content-Type': 'application/json' }
  switch (plan.route) {
    case 'webhooksender': {
      const { sender } = plan
      const access: Record<string, string> = sender.access
        ? { 'CF-Access-Client-Id': sender.access.clientId, 'CF-Access-Client-Secret': sender.access.clientSecret }
        : {}
      return {
        url: sender.endpoint,
        headers: { ...access, Authorization: `Bearer ${sender.authToken}`, ...json },
        body: [{ targets: [plan.webhook], body, retry_limit: 10 }],
      }
    }
    case 'webhook':
      return { url: `${plan.webhook}${target.threadId ? '&' : '?'}wait=true`, headers: json, body }
    case 'nowebhook':
      return {
        url: `https://discord.com/api/v10/channels/${target.targetId}/messages`,
        headers: { ...json, Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
        body,
      }
  }
}

export async function deliverTestMessage(
  plan: DeliveryPlan,
  env: Bindings,
  target: Target,
  body: TestMessageBody,
): Promise<void> {
  const { url, headers, body: payload } = request(plan, env, target, body)
  const response = await send(url, { method: 'POST', headers, body: JSON.stringify(payload) })
  const viaSender = plan.route === 'webhooksender'
  if (viaSender && (response.status === 401 || response.status === 403)) throw new DeliveryError('configuration')
  if (!viaSender && response.status === 403) throw new DeliveryError('missingperms')
  if (plan.route === 'webhook' && response.status === 404) throw new DeliveryError('unknownwebhook')
  if (response.status === 429) throw new DeliveryError('ratelimit')
  if (response.status >= 500) throw new DeliveryError('unavailable')
  const ok = viaSender
    ? response.status === 200 && response.body.trim() === 'OK'
    : response.status >= 200 && response.status < 300
  if (!ok) throw new DeliveryError('unknown')
}
