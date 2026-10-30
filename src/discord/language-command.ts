import { ButtonStyleTypes, InteractionType, MessageComponentTypes } from 'discord-interactions'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Destination } from '../db/destination-types'
import type { Bindings } from '../env'
import { displayLanguage, isLanguageCode, LANGUAGES, type LanguageCode, translate } from '../i18n/languages'
import { log } from '../log'
import { ERROR_REPLY_BUDGET_MS, OPERATION_BUDGET_MS } from './constants'
import { claimInteraction } from './receipts'
import { DiscordRest } from './rest'
import { DiscordState } from './state'
import { type GuildInteraction, type Interaction, InteractionError, type Message, message, sameTarget } from './types'

const CUSTOM_ID_PREFIX = 'eewlang:'

/** Component actions: s(elect) a language for this channel, a(pply) it to the whole guild. */
type Action = 's' | 'a'

export function isLanguageInteraction(i: Interaction): boolean {
  return (
    (i.type === InteractionType.APPLICATION_COMMAND && i.data?.name === 'lang') ||
    (i.type === InteractionType.MESSAGE_COMPONENT &&
      typeof i.data?.custom_id === 'string' &&
      i.data.custom_id.startsWith(CUSTOM_ID_PREFIX))
  )
}

function parseComponent(i: GuildInteraction): { sessionId: string; action: Action } {
  const match = /^eewlang:([a-f0-9]{32}):([sa])$/.exec(i.customId ?? '')
  const sessionId = match?.[1]
  const action = match?.[2] as Action | undefined
  if (!sessionId || !action) throw new InteractionError(translate('ja_jp', 'stale'))
  const expected = action === 's' ? MessageComponentTypes.STRING_SELECT : MessageComponentTypes.BUTTON
  if (i.componentType !== expected) throw new InteractionError(translate('ja_jp', 'stale'))
  return { sessionId, action }
}

function selectedLanguage(i: GuildInteraction): LanguageCode {
  const values = i.values
  if (!Array.isArray(values) || values.length !== 1 || !isLanguageCode(values[0])) {
    throw new InteractionError(translate('ja_jp', 'invalid'))
  }
  return values[0]
}

function languageMenu(d: Destination, session: string, content?: string): Message {
  return message(content ?? displayLanguage(d.lang).name, [
    {
      type: MessageComponentTypes.ACTION_ROW,
      components: [
        {
          type: MessageComponentTypes.STRING_SELECT,
          custom_id: `${CUSTOM_ID_PREFIX}${session}:s`,
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
          custom_id: `${CUSTOM_ID_PREFIX}${session}:a`,
          label: translate(d.lang, 'applyLabel'),
        },
      ],
    },
  ])
}

/** /lang and its components. Runs in waitUntil() after a deferred ACK. */
export async function processLanguage(i: GuildInteraction, env: Bindings): Promise<void> {
  const botToken = env.DISCORD_BOT_TOKEN ?? ''
  const rest = new DiscordRest(botToken)
  const started = Date.now()
  let locale: string = 'ja_jp'
  let savedContent: string | undefined
  const stale = () => new InteractionError(translate(locale, 'stale'))
  const checkBudget = () => {
    if (Date.now() - started > OPERATION_BUDGET_MS) throw stale()
  }
  try {
    const { DB, DISCORD_APPLICATION_ID } = env
    if (!DB || !DISCORD_APPLICATION_ID) throw new InteractionError(translate(locale, 'failed'))
    const store = new D1DestinationStore(DB)
    const state = new DiscordState(DB)
    const parsed = i.type === InteractionType.MESSAGE_COMPONENT ? parseComponent(i) : null
    if (!(await claimInteraction(DB, i.id))) return

    const session = parsed ? await state.session(parsed.sessionId, ['lang']) : null
    if (parsed) {
      if (
        !session?.language ||
        session.actorId !== i.actorId ||
        session.guildId !== i.guildId ||
        session.targetId !== i.channelId
      ) {
        throw stale()
      }
      locale = session.language
    }
    await rest.verifyApplication(DISCORD_APPLICATION_ID)
    const { target } = await rest.target(i)
    if (session && (session.channelId !== target.channelId || session.threadId !== target.threadId)) throw stale()
    let current = await store.getVersionedDestination(target.targetId)
    if (current.destination && !sameTarget(current.destination, target)) throw stale()

    if (!parsed || !session?.language) {
      // /lang registers the channel with defaults so it has a language to show.
      if (!current.destination) {
        checkBudget()
        await store.insertDestinationIfAbsent(target)
        current = await store.getVersionedDestination(target.targetId)
      }
    } else {
      const sessionLanguage = session.language
      if (
        !current.destination ||
        current.revision !== session.revision ||
        current.destination.lang !== sessionLanguage
      ) {
        throw stale()
      }
      const all = parsed.action === 'a'
      if (all && i.values !== undefined) throw new InteractionError(translate(locale, 'invalid'))
      const language = all ? sessionLanguage : selectedLanguage(i)
      checkBudget()
      const affected = await store.changeLanguageFromSession(
        target,
        { id: session.id, actorId: i.actorId, revision: session.revision, language: sessionLanguage },
        language,
        all ? 'guild' : 'target',
      )
      if (affected === 0) throw stale()
      // A positive count confirms the commit. Later read/UI failures cannot undo it.
      locale = language
      savedContent = translate(language, all ? 'applied' : 'set', displayLanguage(language).name)
      if (all) savedContent += `\n${translate(language, 'count', String(affected))}`
      current = await store.getVersionedDestination(target.targetId)
      // Unrelated commits may advance the global revision again before this read.
      if (current.revision < session.revision + 1 || current.destination?.lang !== language) throw stale()
    }
    if (!current.destination || !sameTarget(current.destination, target)) throw stale()
    locale = current.destination.lang
    checkBudget()
    const next = await state.createSession('lang', i.actorId, target, current.revision, current.destination.lang)
    await rest.edit(i, languageMenu(current.destination, next, savedContent))
  } catch (error) {
    const content =
      savedContent !== undefined
        ? `${savedContent}\n${translate(locale, 'refresh')}`
        : error instanceof InteractionError
          ? error.message
          : translate(locale, 'failed')
    try {
      await new DiscordRest(botToken, Date.now() + ERROR_REPLY_BUDGET_MS).edit(i, message(content))
    } catch {
      log.warn('discord_language_response_failed', { interactionId: i.id })
    }
  }
}
