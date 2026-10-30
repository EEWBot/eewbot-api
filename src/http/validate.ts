import type { Snowflake } from '../db/destination-types'
import { isSnowflake } from '../db/destination-validation'
import { ApiError } from './errors'

export const INVALID_REQUEST = 'invalid_request'

/** A plain JSON object. Unknown keys are ignored so Core can add fields freely. */
export function object(value: unknown, code = INVALID_REQUEST): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(code)
  return value as Record<string, unknown>
}

export function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
  code = INVALID_REQUEST,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new ApiError(code)
}

export function snowflake(value: unknown, code = INVALID_REQUEST): Snowflake {
  if (!isSnowflake(value)) throw new ApiError(code)
  return value
}

export function boundedArray(value: unknown, maxLength: number, code = INVALID_REQUEST): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) throw new ApiError(code)
  return value
}
