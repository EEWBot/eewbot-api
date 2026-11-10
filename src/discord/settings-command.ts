import { ButtonStyleTypes, InteractionType, MessageComponentTypes } from 'discord-interactions'
import { D1DestinationStore, type DestinationChange } from '../db/d1-destination-store'
import type { Destination, DestinationFlags, Intensity } from '../db/destination-types'
import type { Bindings } from '../env'
import { apiText } from '../i18n/api'
import { coreText, formatCoreText } from '../i18n/core'
import { interactionLanguage } from '../i18n/discord'
import { INTENSITIES, setupFollowup, setupOptionText, setupReply } from '../i18n/settings'
import { log } from '../log'
import { Permission } from './constants'
import { hasPermission } from './permissions'
import { DiscordRest } from './rest'
import {
  type AuthorizedInteraction,
  type Interaction,
  InteractionError,
  type Message,
  message,
  sameTarget,
  type Target,
  targetOf,
} from './types'

const CUSTOM_ID_PREFIX = 'eew:'
const BASE = ['eewAlert', 'eewPrediction', 'quakeInfo', 'tsunami'] as const
const MODIFIER = ['eewDecimation'] as const
/** Incoming webhook type. */
const INCOMING_WEBHOOK = 1

/** Component actions: b(ase flags), m(odifier flags), i(ntensity) on /setup; c(onfirm), x (cancel) on /unregister. */
type Action = 'b' | 'm' | 'i' | 'c' | 'x'
const SELECT_ACTIONS: readonly Action[] = ['b', 'm', 'i']

export function isSettingsInteraction(i: Interaction): boolean {
  return (
    (i.type === InteractionType.APPLICATION_COMMAND && (i.data?.name === 'setup' || i.data?.name === 'unregister')) ||
    (i.type === InteractionType.MESSAGE_COMPONENT &&
      typeof i.data?.custom_id === 'string' &&
      i.data.custom_id.startsWith(CUSTOM_ID_PREFIX))
  )
}

function row(component: unknown) {
  return { type: MessageComponentTypes.ACTION_ROW, components: [component] }
}

// Menus are ephemeral, so only the invoking member can use them. Each change
// applies to the channel the component is used in; no session state is needed.
function menus(destination: Destination, language: string, content: string): Message {
  const flagMenu = (keys: readonly (keyof DestinationFlags)[], action: Action, group: 'base' | 'modifier') =>
    row({
      type: MessageComponentTypes.STRING_SELECT,
      custom_id: CUSTOM_ID_PREFIX + action,
      placeholder: coreText(language, `eewbot.scmd.setup.${group}.placeholder`),
      min_values: 0,
      max_values: keys.length,
      options: keys.map((key) => ({
        label: setupOptionText(language, group, key, 'label'),
        description: setupOptionText(language, group, key, 'desc'),
        value: key,
        default: destination[key],
      })),
    })
  return message(content, [
    flagMenu(BASE, 'b', 'base'),
    flagMenu(MODIFIER, 'm', 'modifier'),
    row({
      type: MessageComponentTypes.STRING_SELECT,
      custom_id: `${CUSTOM_ID_PREFIX}i`,
      placeholder: coreText(language, 'eewbot.scmd.setup.sensitivity.placeholder'),
      min_values: 1,
      max_values: 1,
      options: INTENSITIES.map((intensity, code) => ({
        label:
          code === 0
            ? coreText(language, 'eewbot.scmd.setup.sensitivity.option.unknown')
            : formatCoreText(language, 'eewbot.scmd.setup.sensitivity.option', intensity),
        value: String(code),
        default: destination.minIntensity === code,
      })),
    }),
  ])
}

function unregisterPrompt(language: string): Message {
  const button = (style: ButtonStyleTypes, label: string, action: Action) =>
    row({ type: MessageComponentTypes.BUTTON, style, label, custom_id: CUSTOM_ID_PREFIX + action })
  return message(coreText(language, 'eewbot.scmd.unregister.confirm'), [
    button(ButtonStyleTypes.DANGER, coreText(language, 'eewbot.scmd.unregister.confirm.label'), 'c'),
    button(ButtonStyleTypes.SECONDARY, coreText(language, 'eewbot.scmd.unregister.cancel.label'), 'x'),
  ])
}

function parseAction(i: AuthorizedInteraction, language: string): Action {
  const t = apiText(language).settings
  const action = /^eew:([bmicx])$/.exec(i.customId ?? '')?.[1] as Action | undefined
  const expected =
    action && SELECT_ACTIONS.includes(action) ? MessageComponentTypes.STRING_SELECT : MessageComponentTypes.BUTTON
  if (!action || i.componentType !== expected) throw new InteractionError(t.invalidValue)
  return action
}

function selectedChange(i: AuthorizedInteraction, action: Action, language: string): DestinationChange {
  const t = apiText(language).settings
  const values = i.values
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) throw new InteractionError(t.invalidValue)
  if (action === 'i') {
    const [value] = values
    if (values.length !== 1 || value === undefined || !/^[0-9]$/.test(value)) throw new InteractionError(t.invalidValue)
    return { minIntensity: Number(value) as Intensity }
  }
  const keys: readonly string[] = action === 'b' ? BASE : MODIFIER
  if (values.some((value) => !keys.includes(value))) throw new InteractionError(t.invalidValue)
  return { flags: Object.fromEntries(keys.map((key) => [key, values.includes(key)])) }
}

/**
 * Gives the target its own webhook: keeps the assigned one while it still
 * exists, else claims an unassigned webhook created by this application, else
 * creates one. Names are display-only. Threads use the parent channel.
 */
async function assignWebhook(
  store: D1DestinationStore,
  rest: DiscordRest,
  target: Target,
  destination: Destination,
  applicationId: string,
  language: string,
): Promise<void> {
  const own = (await rest.webhooks(target.channelId)).filter(
    (hook) =>
      hook.type === INCOMING_WEBHOOK &&
      hook.channel_id === target.channelId &&
      hook.user?.id === applicationId &&
      typeof hook.token === 'string' &&
      hook.token.length > 0,
  )
  const existing = own.find((hook) => hook.id === destination.webhook?.id)
  if (existing?.token) {
    if (existing.id !== destination.webhook?.id || existing.token !== destination.webhook.token) {
      await store.update(target, { webhook: { id: existing.id, token: existing.token } })
    }
    return
  }
  const candidates = own.flatMap((hook) => (hook.token ? [{ id: hook.id, token: hook.token }] : []))
  if ((await store.assignAvailableWebhook(target, candidates)).changes > 0) return
  if (!target.guildId) throw new InteractionError(apiText(language).settings.failed)
  const member = await rest.guildMember(target.guildId, applicationId).catch(() => null)
  // Match Java Core's PartialMember.getDisplayName() and removeUnusableName().
  const username = member?.user.username ?? 'EEWBot'
  const displayName = member?.nick ?? member?.user.global_name ?? username
  const name =
    [displayName, username]
      .map((name) => name.replace(/discord/gi, '').replace(/clyde/gi, ''))
      .find((name) => name.trim().length > 0) ?? 'EEWBot'
  const created = await rest.createWebhook(target.channelId, name)
  if (!created.token) throw new InteractionError(apiText(language).discord.unavailable)
  try {
    if ((await store.assignAvailableWebhook(target, [{ id: created.id, token: created.token }])).changes === 0) {
      throw new InteractionError(coreText(language, 'eewbot.scmd.unregister.notfound'))
    }
  } catch (error) {
    await rest.deleteWebhook(created.id).catch(() => {
      log.warn('discord_orphan_webhook', { targetId: target.targetId })
    })
    throw error
  }
}

async function setup(
  i: AuthorizedInteraction,
  env: Bindings,
  store: D1DestinationStore,
  target: Target,
): Promise<Message> {
  const before = await store.getDestination(target.targetId)
  const language = interactionLanguage(i.locale, before && sameTarget(before, target) ? before.lang : 'ja_jp')
  const t = apiText(language).settings
  if (i.guildId !== null && !hasPermission(i.appPermissions, Permission.VIEW_CHANNEL)) {
    throw new InteractionError(coreText(language, 'eewbot.scmd.setup.permserror.viewchannel'))
  }
  const send = target.threadId ? Permission.SEND_MESSAGES_IN_THREADS : Permission.SEND_MESSAGES
  if (i.guildId !== null && !hasPermission(i.appPermissions, send)) {
    throw new InteractionError(coreText(language, 'eewbot.scmd.setup.permserror.sendmessages'))
  }
  if (before && !sameTarget(before, target)) throw new InteractionError(t.targetMismatch)
  await store.insertIfAbsent(target)
  const canManage = i.guildId !== null && hasPermission(i.appPermissions, Permission.MANAGE_WEBHOOKS)
  const registered = await store.getDestination(target.targetId)
  if (!registered) throw new InteractionError(coreText(language, 'eewbot.scmd.unregister.notfound'))
  if (canManage) {
    await assignWebhook(
      store,
      new DiscordRest(env.DISCORD_BOT_TOKEN, language),
      target,
      registered,
      i.applicationId,
      language,
    )
  }
  const current = await store.getDestination(target.targetId)
  if (!current) throw new InteractionError(coreText(language, 'eewbot.scmd.unregister.notfound'))
  const replyLanguage = interactionLanguage(i.locale, current.lang)
  return menus(current, replyLanguage, setupReply(replyLanguage, i.guildId !== null && !current.webhook))
}

async function component(i: AuthorizedInteraction, store: D1DestinationStore, target: Target): Promise<Message> {
  const current = await store.getDestination(target.targetId)
  const language = interactionLanguage(i.locale, current && sameTarget(current, target) ? current.lang : 'ja_jp')
  const action = parseAction(i, language)
  const notFound = coreText(language, 'eewbot.scmd.unregister.notfound')
  if (action === 'x') return message(coreText(language, 'eewbot.scmd.unregister.cancelled'))
  if (action === 'c')
    return message((await store.remove(target)) > 0 ? coreText(language, 'eewbot.scmd.unregister.done') : notFound)
  await store.update(target, selectedChange(i, action, language))
  const saved = await store.getDestination(target.targetId)
  const replyLanguage = interactionLanguage(i.locale, saved?.lang)
  return saved && sameTarget(saved, target)
    ? menus(saved, replyLanguage, setupFollowup(replyLanguage, action, i.values as string[]))
    : message(notFound)
}

/** /setup, /unregister and their components. Runs in waitUntil() after a deferred ACK. */
export async function processSettings(i: AuthorizedInteraction, env: Bindings): Promise<void> {
  const rest = new DiscordRest()
  let language = interactionLanguage(i.locale)
  let reply: Message
  try {
    if (!env.DB || !env.DISCORD_BOT_TOKEN) throw new InteractionError(apiText(language).settings.failed)
    const store = new D1DestinationStore(env.DB)
    const destination = await store.getDestination(i.channelId)
    if (destination && destination.guildId === i.guildId) language = interactionLanguage(i.locale, destination.lang)
    const target = targetOf(i, language)
    if (i.type === InteractionType.MESSAGE_COMPONENT) reply = await component(i, store, target)
    else if (i.commandName === 'setup') reply = await setup(i, env, store, target)
    else {
      reply = destination ? unregisterPrompt(language) : message(coreText(language, 'eewbot.scmd.unregister.notfound'))
    }
  } catch (error) {
    reply = message(error instanceof InteractionError ? error.message : apiText(language).settings.failed)
  }
  try {
    await rest.edit(i, reply)
  } catch {
    log.warn('discord_settings_response_failed', { interactionId: i.id })
  }
}
