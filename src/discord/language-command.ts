import { ButtonStyleTypes, InteractionType, MessageComponentTypes } from 'discord-interactions'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Destination } from '../db/destination-types'
import type { Bindings } from '../env'
import { displayLanguage, isLanguageCode, LANGUAGES, type LanguageCode, translate } from '../i18n/languages'
import { log } from '../log'
import { DiscordRest } from './rest'
import {
  type GuildInteraction,
  type Interaction,
  InteractionError,
  type Message,
  message,
  sameTarget,
  targetOf,
} from './types'

const CUSTOM_ID_PREFIX = 'eewlang:'

export function isLanguageInteraction(i: Interaction): boolean {
  return (
    (i.type === InteractionType.APPLICATION_COMMAND && i.data?.name === 'lang') ||
    (i.type === InteractionType.MESSAGE_COMPONENT &&
      typeof i.data?.custom_id === 'string' &&
      i.data.custom_id.startsWith(CUSTOM_ID_PREFIX))
  )
}

function selectedLanguage(i: GuildInteraction, locale: string): LanguageCode {
  const values = i.values
  if (
    i.componentType !== MessageComponentTypes.STRING_SELECT ||
    !Array.isArray(values) ||
    values.length !== 1 ||
    !isLanguageCode(values[0])
  ) {
    throw new InteractionError(translate(locale, 'invalid'))
  }
  return values[0]
}

/** s(elect) a language for this channel; a(pply) this channel's language to the whole guild. */
function languageMenu(d: Destination, content?: string): Message {
  return message(content ?? displayLanguage(d.lang).name, [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        {
          type: MessageComponentTypes.STRING_SELECT,
          custom_id: `${CUSTOM_ID_PREFIX}s`,
          min_values: 1,
          max_values: 1,
          options: LANGUAGES.map(({ code, name }) => ({ value: code, label: name, default: code === d.lang })),
        },
      ],
    },
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        {
          type: MessageComponentTypes.BUTTON,
          style: ButtonStyleTypes.PRIMARY,
          custom_id: `${CUSTOM_ID_PREFIX}a`,
          label: translate(d.lang, 'applyLabel'),
        },
      ],
    },
  ])
}

/** /lang and its components. Runs in waitUntil() after a deferred ACK. */
export async function processLanguage(i: GuildInteraction, env: Bindings): Promise<void> {
  let locale: string = 'ja_jp'
  let reply: Message
  try {
    if (!env.DB) throw new InteractionError(translate(locale, 'failed'))
    const store = new D1DestinationStore(env.DB)
    const target = targetOf(i)
    const stale = () => new InteractionError(translate(locale, 'stale'))
    let destination = await store.getDestination(target.targetId)
    if (destination && !sameTarget(destination, target)) throw stale()
    if (destination) locale = destination.lang
    let content: string | undefined

    if (i.type === InteractionType.APPLICATION_COMMAND) {
      // /lang registers the channel with defaults so it has a language to show.
      if (!destination) await store.insertIfAbsent(target)
    } else if (!destination) {
      throw stale()
    } else if (i.customId === `${CUSTOM_ID_PREFIX}a`) {
      const count = await store.setGuildLanguage(target.guildId, destination.lang)
      content = `${translate(locale, 'applied', displayLanguage(locale).name)}\n${translate(locale, 'count', String(count))}`
    } else if (i.customId === `${CUSTOM_ID_PREFIX}s`) {
      const language = selectedLanguage(i, locale)
      if ((await store.update(target, { lang: language })) === 0) throw stale()
      locale = language
      content = translate(language, 'set', displayLanguage(language).name)
    } else {
      throw new InteractionError(translate(locale, 'invalid'))
    }
    destination = await store.getDestination(target.targetId)
    if (!destination) throw stale()
    reply = languageMenu(destination, content)
  } catch (error) {
    reply = message(error instanceof InteractionError ? error.message : translate(locale, 'failed'))
  }
  try {
    await new DiscordRest().edit(i, reply)
  } catch {
    log.warn('discord_language_response_failed', { interactionId: i.id })
  }
}
