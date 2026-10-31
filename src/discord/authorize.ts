import { InteractionType } from 'discord-interactions'
import { isSnowflake } from '../db/destination-validation'
import type { Bindings } from '../env'
import { apiText } from '../i18n/api'
import { Permission } from './constants'
import { hasPermission, parsePermissions } from './permissions'
import type { GuildInteraction, Interaction } from './types'

const text = apiText()

export type Authorization = { ok: true; interaction: GuildInteraction } | { ok: false; message: string }

function deny(message: string): Authorization {
  return { ok: false, message }
}

/**
 * Common authorization, after signature verification: a command or component of
 * this application, inside a guild. Commands are registered for Guild Install
 * only, so Discord itself rejects other contexts.
 */
export function authorizeMember(i: Interaction, env: Bindings): Authorization {
  if (env.DISCORD_COMMANDS_ENABLED !== 'true') return deny(text.auth.commandsDisabled)
  if (i.type !== InteractionType.APPLICATION_COMMAND && i.type !== InteractionType.MESSAGE_COMPONENT) {
    return deny(text.auth.invalidContext)
  }
  const actorId = i.member?.user?.id
  const memberPermissions = parsePermissions(i.member?.permissions)
  const appPermissions = parsePermissions(i.app_permissions)
  const parentId = i.channel?.parent_id ?? null
  if (
    !isSnowflake(env.DISCORD_APPLICATION_ID) ||
    i.application_id !== env.DISCORD_APPLICATION_ID ||
    !isSnowflake(i.guild_id) ||
    !isSnowflake(i.channel_id) ||
    !isSnowflake(i.id) ||
    !isSnowflake(actorId) ||
    (parentId !== null && !isSnowflake(parentId)) ||
    typeof i.token !== 'string' ||
    memberPermissions === null ||
    appPermissions === null
  ) {
    return deny(text.auth.invalidContext)
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
      channelType: i.channel?.type,
      parentId,
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

/** Member authorization plus Manage Guild, for state-changing settings commands. */
export function authorizeAdmin(i: Interaction, env: Bindings): Authorization {
  const result = authorizeMember(i, env)
  if (!result.ok) return result
  if (!hasPermission(result.interaction.memberPermissions, Permission.MANAGE_GUILD)) {
    return deny(text.auth.manageGuildRequired)
  }
  return result
}
