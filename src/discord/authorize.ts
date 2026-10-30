import { InteractionType } from 'discord-interactions'
import { isSnowflake } from '../db/destination-validation'
import type { Bindings } from '../env'
import { ja } from '../i18n/ja'
import { GUILD_CONTEXT, GUILD_INSTALL, Permission, USER_INSTALL } from './constants'
import { hasPermission, parsePermissions } from './permissions'
import type { GuildInteraction, Interaction } from './types'

export type Authorization = { ok: true; interaction: GuildInteraction } | { ok: false; message: string }

const INTERACTION_TOKEN = /^[A-Za-z0-9._-]{1,2048}$/

function deny(message: string): Authorization {
  return { ok: false, message }
}

function optionalPermissions(value: unknown): bigint | undefined | null {
  if (value === undefined) return undefined
  try {
    return parsePermissions(value)
  } catch {
    return null
  }
}

/**
 * Common authorization for every command, run after signature verification and
 * before any D1 or REST access: this application's Guild Install, inside a guild,
 * with well-formed identifiers. Produces a narrowed, validated interaction.
 */
export function authorizeMember(i: Interaction, env: Bindings): Authorization {
  if (env.DISCORD_COMMANDS_ENABLED !== 'true') return deny(ja.auth.commandsDisabled)
  if (!isSnowflake(env.DISCORD_APPLICATION_ID) || !isSnowflake(i.guild_id)) return deny(ja.auth.invalidContext)
  const owners = i.authorizing_integration_owners
  if (
    i.application_id !== env.DISCORD_APPLICATION_ID ||
    i.context !== GUILD_CONTEXT ||
    !owners ||
    owners[GUILD_INSTALL] !== i.guild_id ||
    Object.hasOwn(owners, USER_INSTALL)
  ) {
    return deny(ja.auth.guildInstallOnly)
  }
  if (i.type !== InteractionType.APPLICATION_COMMAND && i.type !== InteractionType.MESSAGE_COMPONENT) {
    return deny(ja.auth.invalidContext)
  }
  const actorId = i.member?.user?.id
  const memberPermissions = optionalPermissions(i.member?.permissions)
  const appPermissions = optionalPermissions(i.app_permissions)
  if (
    !isSnowflake(i.channel_id) ||
    !isSnowflake(i.id) ||
    !isSnowflake(actorId) ||
    memberPermissions === undefined ||
    memberPermissions === null ||
    appPermissions === null
  ) {
    return deny(ja.auth.invalidContext)
  }
  if (typeof i.token !== 'string' || !INTERACTION_TOKEN.test(i.token)) return deny(ja.auth.invalidToken)
  const options = i.data?.options
  if (i.type === InteractionType.APPLICATION_COMMAND && options !== undefined) {
    if (!Array.isArray(options) || options.length !== 0) return deny(ja.auth.noOptions)
  }
  return {
    ok: true,
    interaction: {
      type: i.type,
      id: i.id,
      applicationId: i.application_id,
      token: i.token,
      guildId: i.guild_id,
      channelId: i.channel_id,
      actorId,
      memberPermissions,
      appPermissions,
      commandName: typeof i.data?.name === 'string' ? i.data.name : undefined,
      customId: typeof i.data?.custom_id === 'string' ? i.data.custom_id : undefined,
      componentType: i.data?.component_type,
      values: i.data?.values,
    },
  }
}

/** Member authorization plus the requirements of state-changing settings commands. */
export function authorizeAdmin(i: Interaction, env: Bindings): Authorization {
  const result = authorizeMember(i, env)
  if (!result.ok) return result
  if (!env.DISCORD_BOT_TOKEN) return deny(ja.auth.settingsDisabled)
  if (!hasPermission(result.interaction.memberPermissions, Permission.MANAGE_GUILD)) {
    return deny(ja.auth.manageGuildRequired)
  }
  return result
}
