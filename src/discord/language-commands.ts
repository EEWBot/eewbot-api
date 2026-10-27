import { D1DestinationStore } from '../db/d1-destination-store'
import type { Destination } from '../db/destination-types'
import type { Bindings } from '../env'
import { displayLanguage, isLanguageCode, LANGUAGES, translate, type LanguageCode } from '../i18n/languages'
import { DiscordRest } from './rest'
import { DiscordState } from './state'
import { InteractionError, message, sameTarget, type Interaction, type Message } from './types'

export function isLanguageInteraction(i: Interaction): boolean {
  return (i.type === 2 && i.data?.name === 'lang')
    || (i.type === 3 && typeof i.data?.custom_id === 'string' && i.data.custom_id.startsWith('eewlang:'))
}

function component(i: Interaction): { id: string; action: 's' | 'a' } {
  const match = /^eewlang:([a-f0-9]{32}):([sa])$/.exec(String(i.data?.custom_id))
  if (!match || i.data?.component_type !== (match[2] === 's' ? 3 : 2)) throw new InteractionError(translate('ja_jp', 'stale'))
  return { id: match[1], action: match[2] as 's' | 'a' }
}

function selectedLanguage(i: Interaction): LanguageCode {
  const values = i.data?.values
  if (!Array.isArray(values) || values.length !== 1 || !isLanguageCode(values[0])) {
    throw new InteractionError(translate('ja_jp', 'invalid'))
  }
  return values[0]
}

function languageMenu(d: Destination, session: string, content?: string): Message {
  const language = displayLanguage(d.lang)
  const known = isLanguageCode(d.lang)
  return message(content ?? (known ? language.name : translate('ja_jp', 'unknown')), [
    { type: 1, components: [{ type: 3, custom_id: `eewlang:${session}:s`, min_values: 1, max_values: 1,
      options: LANGUAGES.map(({ code, name }) => ({ value: code, label: name, default: code === language.code })) }] },
    { type: 1, components: [{ type: 2, style: 1, custom_id: `eewlang:${session}:a`,
      label: translate(d.lang, 'applyLabel'), disabled: !known }] },
  ])
}

/** Called by the common, already signature- and permission-verified route. */
export async function processLanguage(i: Interaction, env: Bindings): Promise<void> {
  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN!)
  const started = Date.now()
  let locale = 'ja_jp'
  let savedContent: string | undefined
  const stale = () => new InteractionError(translate(locale, 'stale'))
  const checkBudget = () => { if (Date.now() - started > 18_000) throw stale() }
  try {
    if (!env.DB) throw new InteractionError(translate(locale, 'failed'))
    const store = new D1DestinationStore(env.DB)
    const state = new DiscordState(env.DB)
    const parsed = i.type === 3 ? component(i) : null
    if (!await state.claimInteraction(i.id!)) return
    const actor = i.member!.user!.id!
    const active = parsed ? await state.languageSession(parsed.id) : null
    if (parsed && (!active || active.actor_id !== actor || active.guild_id !== i.guild_id || active.target_id !== i.channel_id)) throw stale()
    if (active) locale = active.language
    await rest.verifyApplication(env.DISCORD_APPLICATION_ID!)
    const { target } = await rest.target(i)
    if (active && (active.channel_id !== target.channelId || active.thread_id !== target.threadId)) throw stale()
    let current = await store.getVersionedDestination(target.targetId)
    if (current.destination && !sameTarget(current.destination, target)) throw stale()
    if (!parsed) {
      if (!current.destination) {
        checkBudget()
        await store.insertDestinationIfAbsent(target)
        current = await store.getVersionedDestination(target.targetId)
      }
    } else {
      if (!active || !current.destination || current.revision !== active.revision || current.destination.lang !== active.language) throw stale()
      const all = parsed.action === 'a'
      if (all && (!isLanguageCode(active.language) || i.data?.values !== undefined)) throw new InteractionError(translate(locale, 'invalid'))
      const language = all ? active.language as LanguageCode : selectedLanguage(i)
      checkBudget()
      const affected = await store.changeLanguageFromSession(target, {
        id: active.id, actorId: actor, revision: active.revision, language: active.language,
      }, language, all ? 'guild' : 'target')
      if (affected === 0) throw stale()
      // A positive count confirms the commit. Later reads/UI failures cannot undo it.
      locale = language
      savedContent = translate(language, all ? 'applied' : 'set', displayLanguage(language).name)
      if (all) savedContent += '\n' + translate(language, 'count', String(affected))
      current = await store.getVersionedDestination(target.targetId)
      // Unrelated commits may advance the global revision again before this read.
      if (current.revision < active.revision + 1 || current.destination?.lang !== language) throw stale()
    }
    if (!current.destination || !sameTarget(current.destination, target)) throw stale()
    locale = current.destination.lang
    checkBudget()
    const session = await state.createLanguageSession(actor, target, current.revision, current.destination.lang)
    await rest.edit(i, languageMenu(current.destination, session, savedContent))
  } catch (error) {
    const content = savedContent !== undefined ? savedContent + '\n' + translate(locale, 'refresh')
      : error instanceof InteractionError ? error.message : translate(locale, 'failed')
    try { await new DiscordRest(env.DISCORD_BOT_TOKEN!, Date.now() + 5000).edit(i, message(content)) }
    catch { console.warn('Discord language response unavailable') }
  }
}
