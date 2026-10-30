import { Permission } from './constants'

/** Parses Discord's decimal permission bitfield string, or returns null. */
export function parsePermissions(value: unknown): bigint | null {
  return typeof value === 'string' && /^\d{1,40}$/.test(value) ? BigInt(value) : null
}

/** Administrator implies every permission. */
export function hasPermission(value: bigint, required: bigint): boolean {
  return (value & Permission.ADMINISTRATOR) !== 0n || (value & required) === required
}
