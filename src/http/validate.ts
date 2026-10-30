import type { Snowflake } from '../db/destination-types'
import { isSnowflake } from '../db/destination-validation'
import { ApiError } from './errors'

export const INVALID_REQUEST = 'invalid_request'

/** A plain object with no keys outside `keys` and every key in `required`. */
export function strictObject(
  value: unknown,
  keys: readonly string[],
  { required = keys, code = INVALID_REQUEST }: { required?: readonly string[]; code?: string } = {},
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new ApiError(code)
  }
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

/** Lower-case RFC 4122 version 4 UUID. */
export function uuid(value: unknown, code = 'invalid_id'): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new ApiError(code)
  }
  return value
}
