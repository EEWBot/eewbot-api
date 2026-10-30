import { InteractionType } from 'discord-interactions'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Bindings } from '../env'
import { helpText } from '../i18n/help'
import { ja } from '../i18n/ja'
import { displayLanguage, type LanguageCode } from '../i18n/languages'
import { EMBED_COLOR, INFO_DB_TIMEOUT_MS, INVITE_PERMISSIONS } from './constants'
import { type InteractionResponse, reply } from './responses'
import type { GuildInteraction, Interaction } from './types'

export function isInfoInteraction(i: Interaction): boolean {
  return i.type === InteractionType.APPLICATION_COMMAND && (i.data?.name === 'help' || i.data?.name === 'invite')
}

const HELP_COMMANDS = ['setup', 'quakeinfo', 'invite', 'testmessage', 'lang', 'unregister', 'help'] as const

export function helpEmbed(language: LanguageCode) {
  const field = (name: string, value: string) => ({ name, value, inline: false })
  return {
    title: helpText(language, 'title'),
    description: helpText(language, 'desc'),
    color: EMBED_COLOR,
    fields: [
      ...HELP_COMMANDS.map((command) => field(`/${command}`, helpText(language, command))),
      field(helpText(language, 'linksName'), helpText(language, 'links')),
      field(helpText(language, 'legalName'), helpText(language, 'legal')),
    ],
  }
}

export function inviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&permissions=${INVITE_PERMISSIONS}&scope=bot%20applications.commands`
}

/** The channel's configured language, bounded so the synchronous reply meets Discord's deadline. */
async function channelLanguage(i: GuildInteraction, env: Bindings): Promise<LanguageCode> {
  if (!env.DB) return 'ja_jp'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const destination = await Promise.race([
      new D1DestinationStore(env.DB).getDestination(i.channelId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), INFO_DB_TIMEOUT_MS)
      }),
    ])
    return destination && destination.guildId === i.guildId ? displayLanguage(destination.lang).code : 'ja_jp'
  } catch {
    // Storage failures fall back to Japanese.
    return 'ja_jp'
  } finally {
    clearTimeout(timer)
  }
}

/** /help (public) and /invite (ephemeral) answer synchronously. */
export async function infoResponse(i: GuildInteraction, env: Bindings): Promise<InteractionResponse> {
  if (i.commandName === 'invite') {
    return reply({ content: ja.invite(inviteUrl(i.applicationId)) }, { ephemeral: true })
  }
  return reply({ embeds: [helpEmbed(await channelLanguage(i, env))] })
}
