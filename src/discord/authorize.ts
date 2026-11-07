import { InteractionType } from 'discord-interactions'
import { isSnowflake } from '../db/destination-validation'
import type { Bindings } from '../env'
import { apiText } from '../i18n/api'
import { ChannelType, Permission } from './constants'
import { hasPermission, parsePermissions } from './permissions'
import type { AuthorizedInteraction, Interaction } from './types'

const text = apiText()

export type Authorization = { ok: true; interaction: AuthorizedInteraction } | { ok: false; message: string }

function deny(message: string): Authorization {
  return { ok: false, message }
}

/**
 * Common authorization after signature verification. Guild members use member
 * data; bot DMs use the invoking user. Other private channels are unsupported.
 */
export function authorizeUser(i: Interaction, env: Bindings): Authorization {
  if (env.DISCORD_COMMANDS_ENABLED !== 'true') return deny(text.auth.commandsDisabled)
  if (i.type !== InteractionType.APPLICATION_COMMAND && i.type !== InteractionType.MESSAGE_COMPONENT) {
    return deny(text.auth.invalidContext)
  }
  const isDm = i.context === 1 && i.guild_id === undefined && i.channel?.type === ChannelType.DM
  const guildId = isSnowflake(i.guild_id) ? i.guild_id : null
  const actorId = isDm ? i.user?.id : i.member?.user?.id
  const memberPermissions = isDm ? 0n : parsePermissions(i.member?.permissions)
  const appPermissions = parsePermissions(i.app_permissions)
  const parentId = i.channel?.parent_id ?? null
  if (
    !isSnowflake(env.DISCORD_APPLICATION_ID) ||
    i.application_id !== env.DISCORD_APPLICATION_ID ||
    (isDm
      ? i.member !== undefined || parentId !== null
      : guildId === null || (i.context !== undefined && i.context !== 0) || i.channel?.type === ChannelType.DM) ||
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
      guildId,
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

/** Settings require Manage Guild in a guild; DM users manage their own destination. */
export function authorizeAdmin(i: Interaction, env: Bindings): Authorization {
  const result = authorizeUser(i, env)
  if (!result.ok) return result
  if (
    result.interaction.guildId !== null &&
    !hasPermission(result.interaction.memberPermissions, Permission.MANAGE_GUILD)
  ) {
    return deny(text.auth.manageGuildRequired)
  }
  return result
}
