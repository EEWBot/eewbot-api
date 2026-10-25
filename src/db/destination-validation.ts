import type { Intensity, Snowflake } from './destination-types'

export function assertSnowflake(value: unknown): asserts value is Snowflake {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    /\s/.test(value) ||
    BigInt(value) > 18446744073709551615n
  ) {
    throw new TypeError('Invalid Snowflake: expected a positive unsigned 64-bit decimal string')
  }
}

export function assertIntensity(value: unknown): asserts value is Intensity {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9) {
    throw new TypeError('Invalid intensity code')
  }
}

export function assertLanguage(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new TypeError('Language must be a non-null string')
}

export function booleanToSql(value: unknown): number {
  if (typeof value !== 'boolean') throw new TypeError('Expected a boolean flag')
  return value ? 1 : 0
}

/** Never include the input URL, URL parser exception, or token in an error. */
export function parseWebhookId(value: unknown): Snowflake {
  try {
    if (typeof value !== 'string' || /\s/.test(value)) throw new Error()
    const match = /^https:\/\/discord\.com\/api\/webhooks\/([1-9][0-9]{0,19})\/[A-Za-z0-9_-]+(?:\?[^#\s]*)?$/.exec(value)
    if (!match) throw new Error()
    const id = match[1]
    assertSnowflake(id)
    const threadIds = new URL(value).searchParams.getAll('thread_id')
    if (threadIds.length > 1) throw new Error()
    if (threadIds.length === 1) assertSnowflake(threadIds[0])
    return id
  } catch {
    throw new TypeError('Invalid Discord webhook URL')
  }
}
