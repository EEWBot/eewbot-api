import { ja } from '../i18n/ja'
import { Permission } from './constants'
import { InteractionError } from './types'

/** Parses Discord's decimal permission bitfield string. */
export function parsePermissions(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value)) {
    throw new InteractionError(ja.discord.invalidPermissions)
  }
  return BigInt(value)
}

/** Administrator implies every permission. */
export function hasPermission(value: bigint, required: bigint): boolean {
  return (value & Permission.ADMINISTRATOR) !== 0n || (value & required) === required
}
