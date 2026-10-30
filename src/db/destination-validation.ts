import type { Intensity, Snowflake, WebhookCredential } from './destination-types'

const MAX_SNOWFLAKE = 18446744073709551615n

export function isSnowflake(value: unknown): value is Snowflake {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= MAX_SNOWFLAKE
}

export function assertSnowflake(value: unknown): asserts value is Snowflake {
  if (!isSnowflake(value)) {
    throw new TypeError('Invalid Snowflake: expected a positive unsigned 64-bit decimal string')
  }
}

export function assertIntensity(value: unknown): asserts value is Intensity {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9) {
    throw new TypeError('Invalid intensity code')
  }
}

export function booleanToSql(value: unknown): 0 | 1 {
  if (typeof value !== 'boolean') throw new TypeError('Expected a boolean flag')
  return value ? 1 : 0
}

const WEBHOOK_TOKEN = /^[A-Za-z0-9_-]{20,256}$/

/** Never include the token in an error message. */
export function assertWebhook(value: WebhookCredential): void {
  assertSnowflake(value.id)
  if (typeof value.token !== 'string' || !WEBHOOK_TOKEN.test(value.token)) {
    throw new TypeError('Invalid Discord webhook token')
  }
}

/** Builds the execute URL on the fixed Discord origin from validated parts. */
export function webhookUrl(webhook: WebhookCredential, threadId: Snowflake | null): string {
  assertWebhook(webhook)
  if (threadId !== null) assertSnowflake(threadId)
  const base = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`
  return threadId === null ? base : `${base}?thread_id=${threadId}`
}
