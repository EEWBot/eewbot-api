import { ButtonStyleTypes, InteractionType, MessageComponentTypes } from 'discord-interactions'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { DestinationChange } from '../db/destination-store'
import type { Destination, DestinationFlags, Intensity } from '../db/destination-types'
import type { Bindings } from '../env'
import { coreText, formatCoreText } from '../i18n/core'
import { ja } from '../i18n/ja'
import { INTENSITIES, setupFollowup, setupOptionText, setupReply } from '../i18n/settings'
import { log } from '../log'
import { ERROR_REPLY_BUDGET_MS, OPERATION_BUDGET_MS, Permission } from './constants'
import { hasPermission } from './permissions'
import { claimInteraction } from './receipts'
import { DiscordRest, DiscordRestError, isOwnWebhook, type OwnedWebhook } from './rest'
import { DiscordState, type Session } from './state'
import {
  type GuildInteraction,
  type Interaction,
  InteractionError,
  type Message,
  message,
  sameTarget,
  type Target,
} from './types'

const t = ja.settings

const CUSTOM_ID_PREFIX = 'eew:'
const BASE = ['eewAlert', 'eewPrediction', 'quakeInfo', 'tsunami'] as const
const MODIFIER = ['eewDecimation'] as const

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

function customId(session: string, action: Action): string {
  return `${CUSTOM_ID_PREFIX}${session}:${action}`
}

function row(component: unknown) {
  return { type: MessageComponentTypes.ACTION_ROW, components: [component] }
}

function menus(destination: Destination, session: string, content?: string, noWebhook = false): Message {
  const language = destination.lang
  const flagMenu = (keys: readonly (keyof DestinationFlags)[], action: Action, group: 'base' | 'modifier') =>
    row({
      type: MessageComponentTypes.STRING_SELECT,
      custom_id: customId(session, action),
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
  return message(content ?? setupReply(language, noWebhook), [
    flagMenu(BASE, 'b', 'base'),
    flagMenu(MODIFIER, 'm', 'modifier'),
    row({
      type: MessageComponentTypes.STRING_SELECT,
      custom_id: customId(session, 'i'),
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

function unregisterPrompt(language: string, session: string): Message {
  const button = (style: ButtonStyleTypes, label: string, action: Action) =>
    row({ type: MessageComponentTypes.BUTTON, style, label, custom_id: customId(session, action) })
  return message(coreText(language, 'eewbot.scmd.unregister.confirm'), [
    button(ButtonStyleTypes.DANGER, coreText(language, 'eewbot.scmd.unregister.confirm.label'), 'c'),
    button(ButtonStyleTypes.SECONDARY, coreText(language, 'eewbot.scmd.unregister.cancel.label'), 'x'),
  ])
}

function parseComponent(i: GuildInteraction): { sessionId: string; action: Action } {
  const match = /^eew:([a-f0-9]{32}):([bmicx])$/.exec(i.customId ?? '')
  const sessionId = match?.[1]
  const action = match?.[2] as Action | undefined
  if (!sessionId || !action) throw new InteractionError(t.stale)
  const expected = SELECT_ACTIONS.includes(action) ? MessageComponentTypes.STRING_SELECT : MessageComponentTypes.BUTTON
  if (i.componentType !== expected) throw new InteractionError(t.stale)
  return { sessionId, action }
}

function selectedChange(i: GuildInteraction, action: Action): DestinationChange {
  const values = i.values
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string') || new Set(values).size !== values.length) {
    throw new InteractionError(t.invalidSelection)
  }
  if (action === 'i') {
    const [value] = values
    if (values.length !== 1 || value === undefined || !/^[0-9]$/.test(value)) {
      throw new InteractionError(t.invalidIntensity)
    }
    return { minIntensity: Number(value) as Intensity }
  }
  const keys: readonly string[] = action === 'b' ? BASE : MODIFIER
  if (values.some((value) => !keys.includes(value))) throw new InteractionError(t.invalidValue)
  return { flags: Object.fromEntries(keys.map((key) => [key, values.includes(key)])) }
}

type Context = {
  i: GuildInteraction
  env: Bindings & { DB: NonNullable<Bindings['DB']>; DISCORD_APPLICATION_ID: string }
  store: D1DestinationStore
  state: DiscordState
  rest: DiscordRest
  checkBudget: () => void
}

/**
 * Assigns one of this application's channel webhooks to the target, reusing an
 * existing one when possible and creating one otherwise. Requires the setup lock.
 */
async function assignWebhook(ctx: Context, target: Target, owner: string): Promise<void> {
  const { store, rest, checkBudget } = ctx
  const applicationId = ctx.env.DISCORD_APPLICATION_ID
  const current = await store.getVersionedDestination(target.targetId)
  const destination = current.destination
  if (!destination || !sameTarget(destination, target)) throw new InteractionError(t.stale)
  const hooks = await rest.webhooks(target.channelId)
  if (!Array.isArray(hooks)) throw new InteractionError(t.webhookUnavailable)
  const credential = (hook: OwnedWebhook) => ({ id: hook.id, token: hook.token })

  // Prefer the current assignment. The list proves ownership, channel and existence.
  const assigned = destination.webhook?.id
  const candidates = hooks
    .filter((hook) => isOwnWebhook(hook, target, applicationId))
    .sort((a, b) => Number(b.id === assigned) - Number(a.id === assigned))
  for (const hook of candidates) {
    checkBudget()
    const unchanged = destination.webhook?.id === hook.id && destination.webhook.token === hook.token
    if (unchanged && (await store.isWebhookExclusiveToTarget(hook.id, target.targetId))) return
    if (await store.changeIfRevision(target, current.revision, { webhook: credential(hook), lockOwner: owner })) return
    if ((await store.getRevision()) !== current.revision) throw new InteractionError(t.stale)
  }

  checkBudget()
  const created = await rest.createWebhook(target.channelId, target.targetId)
  try {
    if (!isOwnWebhook(created, target, applicationId)) throw new InteractionError(t.webhookUnverified)
    checkBudget()
    const changed = await store.changeIfRevision(target, current.revision, {
      webhook: credential(created),
      lockOwner: owner,
    })
    if (!changed) throw new InteractionError(t.stale)
  } catch (error) {
    // A transport failure after D1 committed is possible: never delete an assigned hook.
    try {
      if (isOwnWebhook(created, target, applicationId) && (await store.isWebhookUnassigned(created.id))) {
        await rest.deleteWebhook(created.id)
      }
    } catch {
      log.warn('discord_orphan_webhook_cleanup_pending', { targetId: target.targetId })
    }
    throw error
  }
}

async function setup(ctx: Context, target: Target, parent: Awaited<ReturnType<DiscordRest['target']>>['parent']) {
  const { i, env, store, state, rest, checkBudget } = ctx
  const destination = await store.getDestination(target.targetId)
  const language = destination && sameTarget(destination, target) ? destination.lang : 'ja_jp'
  const perms = await rest.botPermissions(env.DISCORD_APPLICATION_ID, target, parent, i.appPermissions, language)
  checkBudget()
  const owner = crypto.randomUUID()
  if (!(await state.lock(target.channelId, owner))) throw new InteractionError(t.channelBusy)
  let release = true
  try {
    const before = await store.getDestination(target.targetId)
    if (before && !sameTarget(before, target)) throw new InteractionError(t.targetMismatch)
    checkBudget()
    await store.insertDestinationIfAbsent(target)
    const canManage = hasPermission(perms, Permission.MANAGE_WEBHOOKS)
    if (canManage) {
      await assignWebhook(ctx, target, owner)
    } else {
      const current = await store.getVersionedDestination(target.targetId)
      const cleared =
        !current.destination?.webhook ||
        (await store.changeIfRevision(target, current.revision, { webhook: null, lockOwner: owner }))
      if (!cleared) throw new InteractionError(t.stale)
    }
    const current = await store.getVersionedDestination(target.targetId)
    if (!current.destination || !sameTarget(current.destination, target)) throw new InteractionError(t.stale)
    const session = await state.createSession('setup', i.actorId, target, current.revision)
    return menus(current.destination, session, undefined, !canManage)
  } catch (error) {
    // A timed-out/5xx POST may have created a webhook. Keep the lock until it expires;
    // the next setup lists and reuses that webhook rather than blindly creating another.
    if (error instanceof DiscordRestError && error.ambiguous) release = false
    throw error
  } finally {
    if (release) await state.unlock(target.channelId, owner)
  }
}

async function unregister(ctx: Context, target: Target): Promise<Message> {
  const current = await ctx.store.getVersionedDestination(target.targetId)
  if (!current.destination) return message(coreText('ja_jp', 'eewbot.scmd.unregister.notfound'))
  if (!sameTarget(current.destination, target)) throw new InteractionError(t.stale)
  return unregisterPrompt(
    current.destination.lang,
    await ctx.state.createSession('unregister', ctx.i.actorId, target, current.revision),
  )
}

async function component(ctx: Context, target: Target, session: Session, action: Action): Promise<Message> {
  const { i, store, state, checkBudget } = ctx
  const current = await store.getVersionedDestination(target.targetId)
  if (!current.destination || !sameTarget(current.destination, target) || current.revision !== session.revision) {
    throw new InteractionError(t.stale)
  }
  const language = current.destination.lang
  if (action === 'x') return message(coreText(language, 'eewbot.scmd.unregister.cancelled'))
  const change: DestinationChange = action === 'c' ? { remove: true } : selectedChange(i, action)
  checkBudget()
  if (!(await store.changeIfRevision(target, session.revision, change, { id: session.id, actorId: i.actorId }))) {
    throw new InteractionError(t.stale)
  }
  if (action === 'c') return message(coreText(language, 'eewbot.scmd.unregister.done'))
  const saved = await store.getVersionedDestination(target.targetId)
  if (!saved.destination || !sameTarget(saved.destination, target)) throw new InteractionError(t.stale)
  return menus(
    saved.destination,
    await state.createSession('setup', i.actorId, target, saved.revision),
    setupFollowup(saved.destination.lang, action, i.values as string[]),
  )
}

/** /setup, /unregister and their components. Runs in waitUntil() after a deferred ACK. */
export async function processSettings(i: GuildInteraction, env: Bindings): Promise<void> {
  const botToken = env.DISCORD_BOT_TOKEN ?? ''
  const rest = new DiscordRest(botToken)
  const started = Date.now()
  const checkBudget = () => {
    if (Date.now() - started > OPERATION_BUDGET_MS) throw new InteractionError(t.budgetExceeded)
  }
  try {
    const { DB, DISCORD_APPLICATION_ID } = env
    if (!DB || !DISCORD_APPLICATION_ID) throw new InteractionError(t.storageUnavailable)
    const ctx: Context = {
      i,
      env: { ...env, DB, DISCORD_APPLICATION_ID },
      store: new D1DestinationStore(DB),
      state: new DiscordState(DB),
      rest,
      checkBudget,
    }
    const parsed = i.type === InteractionType.MESSAGE_COMPONENT ? parseComponent(i) : null
    // Cancel is entirely read-only, including UI bookkeeping.
    if (parsed?.action !== 'x' && !(await claimInteraction(DB, i.id))) return

    let session: Session | null = null
    if (parsed) {
      const kind = SELECT_ACTIONS.includes(parsed.action) ? 'setup' : 'unregister'
      session = await ctx.state.session(parsed.sessionId, [kind])
      if (
        !session ||
        session.actorId !== i.actorId ||
        session.guildId !== i.guildId ||
        session.targetId !== i.channelId
      ) {
        throw new InteractionError(t.stale)
      }
    }
    await rest.verifyApplication(DISCORD_APPLICATION_ID)
    const { target, parent } = await rest.target(i)
    if (session && session.channelId !== target.channelId) throw new InteractionError(t.stale)

    let reply: Message
    if (parsed && session) reply = await component(ctx, target, session, parsed.action)
    else if (i.commandName === 'setup') reply = await setup(ctx, target, parent)
    else reply = await unregister(ctx, target)
    await rest.edit(i, reply)
  } catch (error) {
    const text = error instanceof InteractionError ? error.message : t.failed
    try {
      // A fresh budget: the main deadline may already be exhausted.
      await new DiscordRest(botToken, Date.now() + ERROR_REPLY_BUDGET_MS).edit(i, message(text))
    } catch {
      log.warn('discord_settings_response_failed', { interactionId: i.id })
    }
  }
}
