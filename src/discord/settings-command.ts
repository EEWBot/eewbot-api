import { ButtonStyleTypes, InteractionType, MessageComponentTypes } from 'discord-interactions'
import { D1DestinationStore, type DestinationChange } from '../db/d1-destination-store'
import type { Destination, DestinationFlags, Intensity } from '../db/destination-types'
import type { Bindings } from '../env'
import { coreText, formatCoreText } from '../i18n/core'
import { ja } from '../i18n/ja'
import { INTENSITIES, setupFollowup, setupOptionText, setupReply } from '../i18n/settings'
import { log } from '../log'
import { Permission } from './constants'
import { hasPermission } from './permissions'
import { DiscordRest } from './rest'
import {
  type GuildInteraction,
  type Interaction,
  InteractionError,
  type Message,
  message,
  sameTarget,
  type Target,
  targetOf,
} from './types'

const t = ja.settings

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
function menus(destination: Destination, content: string): Message {
  const language = destination.lang
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

function parseAction(i: GuildInteraction): Action {
  const action = /^eew:([bmicx])$/.exec(i.customId ?? '')?.[1] as Action | undefined
  const expected =
    action && SELECT_ACTIONS.includes(action) ? MessageComponentTypes.STRING_SELECT : MessageComponentTypes.BUTTON
  if (!action || i.componentType !== expected) throw new InteractionError(t.invalidValue)
  return action
}

function selectedChange(i: GuildInteraction, action: Action): DestinationChange {
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
 * exists, else reuses this application's webhook named for the target, else
 * creates one. Threads get their own webhook in the parent channel.
 */
async function assignWebhook(
  store: D1DestinationStore,
  rest: DiscordRest,
  target: Target,
  destination: Destination,
  applicationId: string,
): Promise<void> {
  const name = `EEWBot-${target.targetId}`
  const own = (await rest.webhooks(target.channelId)).filter(
    (hook) =>
      hook.type === INCOMING_WEBHOOK &&
      hook.channel_id === target.channelId &&
      hook.user?.id === applicationId &&
      typeof hook.token === 'string',
  )
  const existing = own.find((hook) => hook.id === destination.webhook?.id) ?? own.find((hook) => hook.name === name)
  if (existing?.token) {
    if (existing.id !== destination.webhook?.id || existing.token !== destination.webhook.token) {
      await store.update(target, { webhook: { id: existing.id, token: existing.token } })
    }
    return
  }
  const created = await rest.createWebhook(target.channelId, name)
  if (!created.token) throw new InteractionError(ja.discord.unavailable)
  try {
    await store.update(target, { webhook: { id: created.id, token: created.token } })
  } catch (error) {
    await rest.deleteWebhook(created.id).catch(() => {
      log.warn('discord_orphan_webhook', { targetId: target.targetId })
    })
    throw error
  }
}

async function setup(i: GuildInteraction, env: Bindings, store: D1DestinationStore, target: Target): Promise<Message> {
  const before = await store.getDestination(target.targetId)
  const language = before && sameTarget(before, target) ? before.lang : 'ja_jp'
  if (!hasPermission(i.appPermissions, Permission.VIEW_CHANNEL)) {
    throw new InteractionError(coreText(language, 'eewbot.scmd.setup.permserror.viewchannel'))
  }
  const send = target.threadId ? Permission.SEND_MESSAGES_IN_THREADS : Permission.SEND_MESSAGES
  if (!hasPermission(i.appPermissions, send)) {
    throw new InteractionError(coreText(language, 'eewbot.scmd.setup.permserror.sendmessages'))
  }
  if (before && !sameTarget(before, target)) throw new InteractionError(t.targetMismatch)
  await store.insertIfAbsent(target)
  const canManage = hasPermission(i.appPermissions, Permission.MANAGE_WEBHOOKS)
  const registered = await store.getDestination(target.targetId)
  if (!registered) throw new InteractionError(coreText(language, 'eewbot.scmd.unregister.notfound'))
  if (canManage) {
    await assignWebhook(store, new DiscordRest(env.DISCORD_BOT_TOKEN), target, registered, i.applicationId)
  }
  const current = await store.getDestination(target.targetId)
  if (!current) throw new InteractionError(coreText(language, 'eewbot.scmd.unregister.notfound'))
  return menus(current, setupReply(current.lang, !current.webhook))
}

async function component(i: GuildInteraction, store: D1DestinationStore, target: Target): Promise<Message> {
  const action = parseAction(i)
  const current = await store.getDestination(target.targetId)
  const language = current && sameTarget(current, target) ? current.lang : 'ja_jp'
  const notFound = coreText(language, 'eewbot.scmd.unregister.notfound')
  if (action === 'x') return message(coreText(language, 'eewbot.scmd.unregister.cancelled'))
  if (action === 'c')
    return message((await store.remove(target)) > 0 ? coreText(language, 'eewbot.scmd.unregister.done') : notFound)
  if ((await store.update(target, selectedChange(i, action))) === 0) return message(notFound)
  const saved = await store.getDestination(target.targetId)
  return saved ? menus(saved, setupFollowup(saved.lang, action, i.values as string[])) : message(notFound)
}

/** /setup, /unregister and their components. Runs in waitUntil() after a deferred ACK. */
export async function processSettings(i: GuildInteraction, env: Bindings): Promise<void> {
  const rest = new DiscordRest()
  let reply: Message
  try {
    if (!env.DB || !env.DISCORD_BOT_TOKEN) throw new InteractionError(t.failed)
    const store = new D1DestinationStore(env.DB)
    const target = targetOf(i)
    if (i.type === InteractionType.MESSAGE_COMPONENT) reply = await component(i, store, target)
    else if (i.commandName === 'setup') reply = await setup(i, env, store, target)
    else {
      const destination = await store.getDestination(target.targetId)
      reply = destination
        ? unregisterPrompt(destination.lang)
        : message(coreText('ja_jp', 'eewbot.scmd.unregister.notfound'))
    }
  } catch (error) {
    reply = message(error instanceof InteractionError ? error.message : t.failed)
  }
  try {
    await rest.edit(i, reply)
  } catch {
    log.warn('discord_settings_response_failed', { interactionId: i.id })
  }
}
