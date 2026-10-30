import type { DestinationChange } from '../db/destination-store'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Destination, DestinationFlags, Intensity } from '../db/destination-types'
import { assertSnowflake, parseWebhookId } from '../db/destination-validation'
import type { Bindings } from '../env'
import { DiscordRest, DiscordRestError, hasPermission, MANAGE_WEBHOOKS, permissions, type Webhook } from './rest'
import { DiscordState } from './state'
import { InteractionError, message, sameTarget, type ComponentAction, type Interaction, type Message, type Session, type Target } from './types'

const BASE = ['eewAlert', 'eewPrediction', 'quakeInfo', 'tsunami'] as const
const MODIFIER = ['eewDecimation'] as const
const LABELS = { eewAlert: '緊急地震速報の警報', eewPrediction: '緊急地震速報の予報', quakeInfo: '地震情報',
  tsunami: '津波情報', eewDecimation: '緊急地震速報の間引き' }
const INTENSITIES = ['不明', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7']
const STALE = '設定が変更されたか、この操作の有効期限が切れました。再度 /setup または /unregister を実行してください。'

export function isSettingsInteraction(i: Interaction): boolean {
  return (i.type === 2 && ['setup', 'unregister'].includes(String(i.data?.name)))
    || (i.type === 3 && typeof i.data?.custom_id === 'string' && i.data.custom_id.startsWith('eew:'))
}

/** Runs only after Ed25519 verification, with no D1 or REST access. */
export function authorizeContext(i: Interaction, env: Bindings): string | null {
  try {
    if (env.DISCORD_COMMANDS_ENABLED !== 'true') return 'コマンドは現在無効です。'
    assertSnowflake(env.DISCORD_APPLICATION_ID)
    assertSnowflake(i.guild_id)
    if (i.application_id !== env.DISCORD_APPLICATION_ID
      || i.context !== 0 || !i.authorizing_integration_owners || i.authorizing_integration_owners['0'] !== i.guild_id
      || Object.hasOwn(i.authorizing_integration_owners, '1')) return 'サーバー内のGuild Installから実行してください。'
    assertSnowflake(i.channel_id)
    assertSnowflake(i.id)
    assertSnowflake(i.member?.user?.id)
    permissions(i.member?.permissions)
    if (i.app_permissions !== undefined) permissions(i.app_permissions)
    if (typeof i.token !== 'string' || !/^[A-Za-z0-9._-]{1,2048}$/.test(i.token)) return '応答用の情報が無効です。'
    if (i.type === 2 && i.data?.options !== undefined
      && (!Array.isArray(i.data.options) || i.data.options.length !== 0)) return 'このコマンドには引数を指定できません。'
    return null
  } catch { return 'コマンドの実行コンテキストまたは設定が無効です。' }
}

/** Additional requirements for state-changing settings commands. */
export function authorize(i: Interaction, env: Bindings): string | null {
  const error = authorizeContext(i, env)
  if (error) return error
  if (!env.DISCORD_BOT_TOKEN) return '設定コマンドは現在無効です。'
  try {
    if (!hasPermission(permissions(i.member?.permissions), 1n << 5n)) return 'サーバー管理権限が必要です。'
    return null
  } catch { return '設定コマンドの実行コンテキストまたは設定が無効です。' }
}

function customId(session: string, action: ComponentAction): string { return `eew:${session}:${action}` }
function row(component: unknown) { return { type: 1, components: [component] } }

function menus(destination: Destination, session: string, content = '現在の配信設定です。選択したグループを保存します。'): Message {
  const flagMenu = (keys: readonly (keyof DestinationFlags)[], action: ComponentAction, placeholder: string) => row({
    type: 3, custom_id: customId(session, action), placeholder, min_values: 0, max_values: keys.length,
    options: keys.map((key) => ({ label: LABELS[key], value: key, default: destination[key] })),
  })
  return message(content, [flagMenu(BASE, 'b', '通知する情報'), flagMenu(MODIFIER, 'm', '通知の調整'), row({
    type: 3, custom_id: customId(session, 'i'), placeholder: '最低震度', min_values: 1, max_values: 1,
    options: INTENSITIES.map((label, code) => ({ label: code === 0 ? label : `震度${label}`, value: String(code), default: destination.minIntensity === code })),
  })])
}

function component(i: Interaction): { id: string; action: ComponentAction } {
  const match = /^eew:([a-f0-9]{32}):([bmicx])$/.exec(String(i.data?.custom_id))
  if (!match || i.data?.component_type !== ('bmi'.includes(match[2]) ? 3 : 2)) throw new InteractionError(STALE)
  return { id: match[1], action: match[2] as ComponentAction }
}

function selectedChange(i: Interaction, action: ComponentAction): DestinationChange {
  const values = i.data?.values
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string') || new Set(values).size !== values.length) {
    throw new InteractionError('選択値が無効です。再度 /setup を実行してください。')
  }
  if (action === 'i') {
    if (values.length !== 1 || !/^[0-9]$/.test(values[0])) throw new InteractionError('最低震度は0〜9のコードで指定してください。')
    return { minIntensity: Number(values[0]) as Intensity }
  }
  const keys = action === 'b' ? BASE : MODIFIER
  if (values.some((value) => !(keys as readonly string[]).includes(value))) throw new InteractionError('選択値が無効です。')
  return { flags: Object.fromEntries(keys.map((key) => [key, values.includes(key)])) }
}

async function configuredWebhook(store: D1DestinationStore, rest: DiscordRest, target: Target, applicationId: string,
  owner: string, checkBudget: () => void): Promise<void> {
  const current = await store.getVersionedDestination(target.targetId)
  if (!current.destination || !sameTarget(current.destination, target)) throw new InteractionError(STALE)
  const hooks = await rest.webhooks(target.channelId)
  if (!Array.isArray(hooks)) throw new InteractionError('Webhook情報を確認できません。')
  const own = (hook: Webhook) => hook.type === 1 && hook.channel_id === target.channelId
    && hook.guild_id === target.guildId && hook.user?.id === applicationId && typeof hook.token === 'string'
  const url = (hook: Webhook) => {
    const value = `https://discord.com/api/webhooks/${hook.id}/${hook.token}${target.threadId ? `?thread_id=${target.threadId}` : ''}`
    parseWebhookId(value)
    return value
  }
  // Prefer the current assignment. List results validate ownership, channel and existence.
  const candidates = hooks.filter(own).sort((a, b) => Number(b.id === current.destination!.webhookId) - Number(a.id === current.destination!.webhookId))
  for (const hook of candidates) {
    checkBudget()
    const value = url(hook)
    if (current.destination.webhookUrl === value && await store.isWebhookExclusiveToTarget(hook.id, target.targetId)) return
    if (await store.changeIfRevision(target, current.revision, { webhookUrl: value, lockOwner: owner })) return
    if (await store.getRevision() !== current.revision) throw new InteractionError(STALE)
  }
  checkBudget()
  const created = await rest.createWebhook(target.channelId, target.targetId)
  try {
    if (!own(created)) throw new InteractionError('作成したWebhookを確認できません。')
    checkBudget()
    if (!await store.changeIfRevision(target, current.revision, { webhookUrl: url(created), lockOwner: owner })) throw new InteractionError(STALE)
  } catch (error) {
    // A transport failure after D1 committed is possible: never delete an assigned hook.
    try {
      if (own(created) && await store.isWebhookUnassigned(created.id)) {
        await rest.deleteWebhook(created.id)
      }
    } catch {
      // Never include an exception, URL, token or REST body in diagnostics.
      console.warn('Discord orphan webhook cleanup pending', { targetId: target.targetId })
    }
    throw error
  }
}

export async function processSettings(i: Interaction, env: Bindings): Promise<void> {
  const rest = new DiscordRest(env.DISCORD_BOT_TOKEN!)
  const started = Date.now()
  const checkBudget = () => { if (Date.now() - started > 18_000) throw new InteractionError('処理時間を超過しました。再度実行してください。') }
  try {
    if (!env.DB) throw new InteractionError('設定ストレージが利用できません。')
    const store = new D1DestinationStore(env.DB)
    const state = new DiscordState(env.DB)
    const parsed = i.type === 3 ? component(i) : null
    // Cancel is entirely read-only, including UI bookkeeping.
    if (parsed?.action !== 'x' && !await state.claimInteraction(i.id!)) return
    let active: Session | null = null
    let action: ComponentAction | undefined
    if (i.type === 3) {
      action = parsed!.action
      active = await state.session(parsed!.id)
      if (!active || active.actor_id !== i.member!.user!.id || active.guild_id !== i.guild_id || active.target_id !== i.channel_id
        || active.kind !== ('bmi'.includes(action) ? 'setup' : 'unregister')) throw new InteractionError(STALE)
    }
    await rest.verifyApplication(env.DISCORD_APPLICATION_ID!)
    const { target, parent } = await rest.target(i)
    if (active && active.channel_id !== target.channelId) throw new InteractionError(STALE)
    const actor = i.member!.user!.id!
    let reply: Message
    if (i.type === 2 && i.data?.name === 'setup') {
      const perms = await rest.botPermissions(env.DISCORD_APPLICATION_ID!, target, parent, i.app_permissions)
      checkBudget()
      const owner = crypto.randomUUID()
      if (!await state.lock(target.channelId, owner)) throw new InteractionError('同じチャンネルの設定処理中です。しばらく待って再度実行してください。')
      let release = true
      try {
        const before = await store.getDestination(target.targetId)
        if (before && !sameTarget(before, target)) throw new InteractionError('登録済みの配信先情報が一致しません。')
        checkBudget()
        await store.insertDestinationIfAbsent(target)
        const canManage = hasPermission(perms, MANAGE_WEBHOOKS)
        if (canManage) await configuredWebhook(store, rest, target, env.DISCORD_APPLICATION_ID!, owner, checkBudget)
        else {
          const current = await store.getVersionedDestination(target.targetId)
          if (current.destination?.webhookUrl && !await store.changeIfRevision(target, current.revision, { webhookUrl: null, lockOwner: owner })) {
            throw new InteractionError(STALE)
          }
        }
        const current = await store.getVersionedDestination(target.targetId)
        if (!current.destination || !sameTarget(current.destination, target)) throw new InteractionError(STALE)
        const session = await state.createSession(actor, target, current.revision, 'setup')
        reply = menus(current.destination, session, canManage ? undefined
          : '現在の配信設定です。警告: BotにWebhook管理権限がないため、Webhookなしで登録しました。')
      } catch (error) {
        // A timed-out/5xx POST may have created a webhook. Keep the durable cooldown;
        // next setup lists/reuses it after expiry rather than blindly posting again.
        if (error instanceof DiscordRestError && error.ambiguous) release = false
        throw error
      } finally {
        if (release) await state.unlock(target.channelId, owner)
      }
    } else if (i.type === 2) {
      const current = await store.getVersionedDestination(target.targetId)
      if (!current.destination) reply = message('この配信先は登録されていません。')
      else {
        if (!sameTarget(current.destination, target)) throw new InteractionError(STALE)
        const session = await state.createSession(actor, target, current.revision, 'unregister')
        reply = message('現在の配信先の登録を解除しますか？', [row({ type: 2, style: 4, label: 'Confirm', custom_id: customId(session, 'c') }),
          row({ type: 2, style: 2, label: 'Cancel', custom_id: customId(session, 'x') })])
      }
    } else {
      if (!active || !action) throw new InteractionError(STALE)
      const current = await store.getVersionedDestination(target.targetId)
      if (!current.destination || !sameTarget(current.destination, target) || current.revision !== active.revision) throw new InteractionError(STALE)
      if (action === 'x') reply = message('登録解除をキャンセルしました。')
      else {
        const change = action === 'c' ? { remove: true as const } : selectedChange(i, action)
        checkBudget()
        if (!await store.changeIfRevision(target, active.revision, change, { id: active.id, actorId: actor })) throw new InteractionError(STALE)
        if (action === 'c') reply = message('現在の配信先の登録を解除しました。')
        else {
          const saved = await store.getVersionedDestination(target.targetId)
          if (!saved.destination || !sameTarget(saved.destination, target)) throw new InteractionError(STALE)
          const session = await state.createSession(actor, target, saved.revision, 'setup')
          reply = menus(saved.destination, session, '設定を保存しました。最新のメニューを使用してください。')
        }
      }
    }
    await rest.edit(i, reply)
  } catch (error) {
    const text = error instanceof InteractionError ? error.message : '設定処理に失敗しました。再度実行して現在の設定を確認してください。'
    try {
      // Reserve an independent response budget after operation timeouts.
      await new DiscordRest(env.DISCORD_BOT_TOKEN!, Date.now() + 5000).edit(i, message(text))
    } catch { console.warn('Discord interaction response unavailable') }
  }
}
