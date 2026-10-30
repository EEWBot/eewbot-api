import type { Snowflake, WebhookCredential } from './destination-types'

const MAX_SNOWFLAKE = 18446744073709551615n

/** Canonical positive unsigned 64-bit decimal string. */
export function isSnowflake(value: unknown): value is Snowflake {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= MAX_SNOWFLAKE
}

/** Builds the execute URL on the fixed Discord origin. */
export function webhookUrl(webhook: WebhookCredential, threadId: Snowflake | null): string {
  const base = `https://discord.com/api/webhooks/${webhook.id}/${encodeURIComponent(webhook.token)}`
  return threadId === null ? base : `${base}?thread_id=${threadId}`
}
