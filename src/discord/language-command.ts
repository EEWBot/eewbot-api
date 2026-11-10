import { ButtonStyleTypes, InteractionType, MessageComponentTypes } from 'discord-interactions'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Destination } from '../db/destination-types'
import type { Bindings } from '../env'
import { interactionLanguage } from '../i18n/discord'
import { displayLanguage, isLanguageCode, LANGUAGES, type LanguageCode, translate } from '../i18n/languages'
import { log } from '../log'
import { DiscordRest } from './rest'
import {
  type AuthorizedInteraction,
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

function selectedLanguage(i: AuthorizedInteraction, locale: string): LanguageCode {
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
function languageMenu(d: Destination, language: string, content?: string): Message {
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
    ...(d.guildId === null
      ? []
      : [
          {
            type: MessageComponentTypes.ACTION_ROW,
            components: [
              {
                type: MessageComponentTypes.BUTTON,
                style: ButtonStyleTypes.PRIMARY,
                custom_id: `${CUSTOM_ID_PREFIX}a`,
                label: translate(language, 'applyLabel'),
              },
            ],
          },
        ]),
  ])
}

/** /lang and its components. Runs in waitUntil() after a deferred ACK. */
export async function processLanguage(i: AuthorizedInteraction, env: Bindings): Promise<void> {
  let locale: string = interactionLanguage(i.locale)
  let reply: Message
  try {
    if (!env.DB) throw new InteractionError(translate(locale, 'failed'))
    const store = new D1DestinationStore(env.DB)
    const target = targetOf(i, locale)
    const stale = () => new InteractionError(translate(locale, 'stale'))
    let destination = await store.getDestination(target.targetId)
    if (destination && !sameTarget(destination, target)) throw stale()
    if (destination) locale = interactionLanguage(i.locale, destination.lang)
    let content: string | undefined

    if (i.type === InteractionType.APPLICATION_COMMAND) {
      // /lang registers the channel with defaults so it has a language to show.
      if (!destination) destination = (await store.insertIfAbsent(target)).destination
    } else if (!destination) {
      throw stale()
    } else if (i.customId === `${CUSTOM_ID_PREFIX}a`) {
      if (target.guildId === null) throw new InteractionError(translate(locale, 'invalid'))
      const applied = await store.setGuildLanguage(target.guildId, destination.lang, target.targetId)
      content = `${translate(locale, 'applied', displayLanguage(destination.lang).name)}\n${translate(locale, 'count', String(applied.changes))}`
      destination = applied.destination
    } else if (i.customId === `${CUSTOM_ID_PREFIX}s`) {
      const language = selectedLanguage(i, locale)
      destination = (await store.update(target, { lang: language })).destination
      locale = interactionLanguage(i.locale, language)
      content = translate(locale, 'set', displayLanguage(language).name)
    } else {
      throw new InteractionError(translate(locale, 'invalid'))
    }
    if (!destination || !sameTarget(destination, target)) throw stale()
    reply = languageMenu(destination, interactionLanguage(i.locale, destination.lang), content)
  } catch (error) {
    reply = message(error instanceof InteractionError ? error.message : translate(locale, 'failed'))
  }
  try {
    await new DiscordRest().edit(i, reply)
  } catch {
    log.warn('discord_language_response_failed', { interactionId: i.id })
  }
}
