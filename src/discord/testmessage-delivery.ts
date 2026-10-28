import type { Destination } from '../db/destination-types'
import { assertSnowflake } from '../db/destination-validation'
import type { Bindings } from '../env'
import { boundedRequest } from './http'
import type { Target } from './types'

export type DeliveryRoute = 'webhook' | 'webhooksender' | 'nowebhook'
export type TestMessageBody = { embeds: { title: string; description: string; color: number }[]; allowed_mentions: { parse: never[] } }
export class DeliveryError extends Error {
  constructor(readonly code: 'configuration' | 'missingperms' | 'ratelimit' | 'unknownwebhook' | 'unknown' | 'unavailable') { super(code) }
}
type Sender = { endpoint: string; access: { clientId: string; clientSecret: string } | null; authToken: string }

export function senderConfiguration(env: Bindings): Sender | null {
  if (env.WEBHOOK_SENDER_URL === undefined || env.WEBHOOK_SENDER_URL === '') return null
  try {
    const url = new URL(env.WEBHOOK_SENDER_URL)
    const http = url.protocol === 'http:'
    if ((!http && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash
      || ![url.origin, url.origin + '/'].includes(env.WEBHOOK_SENDER_URL)) throw new Error()
    const { WEBHOOK_SENDER_ACCESS_CLIENT_ID: clientId, WEBHOOK_SENDER_ACCESS_CLIENT_SECRET: clientSecret,
      WEBHOOK_SENDER_AUTH_TOKEN: authToken } = env
    // Separate header credentials. No fallback to Core/Internal Access credentials.
    const valid = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,4096}$/.test(v)
    if (!valid(authToken)) throw new Error()
    if (!clientId && !clientSecret) {
      return { endpoint: url.origin + '/api/send', access: null, authToken }
    }
    // Access is optional as a complete pair, and always requires HTTPS.
    if (http) throw new Error()
    if (!valid(clientId) || !valid(clientSecret)) throw new Error()
    return { endpoint: url.origin + '/api/send', access: { clientId, clientSecret }, authToken }
  } catch { throw new DeliveryError('configuration') }
}

/** Validate exact stored syntax, then reconstruct on the fixed Discord origin. */
export function validatedWebhook(destination: Destination, target: Target): string {
  try {
    const match = /^https:\/\/discord\.com\/api\/webhooks\/([1-9][0-9]{0,19})\/([A-Za-z0-9_-]{20,256})(?:\?thread_id=([1-9][0-9]{0,19}))?$/.exec(destination.webhookUrl ?? '')
    if (!match) throw new Error()
    const [, id, token, threadId] = match
    assertSnowflake(id)
    if (threadId) assertSnowflake(threadId)
    if (id !== destination.webhookId || (threadId ?? null) !== target.threadId) throw new Error()
    return `https://discord.com/api/webhooks/${id}/${token}${threadId ? `?thread_id=${threadId}` : ''}`
  } catch { throw new DeliveryError('configuration') }
}

export function deliveryPlan(env: Bindings, destination: Destination | null, target: Target) {
  if (!destination?.webhookUrl) {
    if (destination?.webhookId) throw new DeliveryError('configuration')
    return { route: 'nowebhook' as const, webhook: null, sender: null }
  }
  const webhook = validatedWebhook(destination, target)
  const sender = senderConfiguration(env)
  return { route: sender ? 'webhooksender' as const : 'webhook' as const, webhook, sender }
}

export async function deliverTestMessage(plan: ReturnType<typeof deliveryPlan>, env: Bindings, target: Target,
  body: TestMessageBody, deadline: number): Promise<void> {
  const sender = plan.sender
  const url = sender ? sender.endpoint : plan.webhook
    ? plan.webhook + (target.threadId ? '&' : '?') + 'wait=true'
    : `https://discord.com/api/v10/channels/${target.targetId}/messages`
  const headers: Record<string, string> = sender ? {
    ...(sender.access ? { 'CF-Access-Client-Id': sender.access.clientId, 'CF-Access-Client-Secret': sender.access.clientSecret } : {}),
    Authorization: `Bearer ${sender.authToken}`, 'Content-Type': 'application/json',
  } : { 'Content-Type': 'application/json', ...(!plan.webhook ? { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } : {}) }
  const response = await boundedRequest(url, { method: 'POST', headers,
    body: JSON.stringify(sender ? [{ targets: [plan.webhook], body, retry_limit: 10 }] : body) }, deadline)
  if (sender && (response.status === 401 || response.status === 403)) throw new DeliveryError('configuration')
  if (!sender && response.status === 403) throw new DeliveryError('missingperms')
  if (!sender && plan.webhook && response.status === 404) throw new DeliveryError('unknownwebhook')
  if (response.status === 429) throw new DeliveryError('ratelimit')
  if (response.status >= 500) throw new DeliveryError('unavailable')
  if (sender ? response.status !== 200 || response.body.trim() !== 'OK' : response.status < 200 || response.status >= 300) {
    throw new DeliveryError('unknown')
  }
}
