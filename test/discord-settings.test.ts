import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { D1DestinationStore } from '../src/db/d1-destination-store'
import { coreText, formatCoreText, LANGUAGES } from '../src/i18n/core'
import { INTENSITIES, setupFollowup, setupReply } from '../src/i18n/settings'
import {
  ACTOR,
  APP,
  BOT_TOKEN,
  bindings,
  CHANNEL,
  command,
  component,
  DiscordMock,
  execute,
  GUILD,
  HOOK_TOKEN,
  inThread,
  type Reply,
  THREAD,
} from './support/discord'
import { resetDb, revision, seedDestination } from './support/fixtures'

type Hook = { id: string; name: string; token?: string; type: number; channel_id: string; user: { id: string } }

const store = new D1DestinationStore(env.DB)
let mock: DiscordMock
let hooks: Hook[]

function hook(id: string, name: string, overrides: Partial<Hook> = {}): Hook {
  return { id, name, token: HOOK_TOKEN, type: 1, channel_id: CHANNEL, user: { id: APP }, ...overrides }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
beforeEach(async () => {
  await resetDb(env.DB)
  hooks = []
  mock = new DiscordMock().install()
  mock.routes.set(`GET /channels/${CHANNEL}/webhooks`, (call) => {
    expect(call.headers.get('Authorization')).toBe(`Bot ${BOT_TOKEN}`)
    return Response.json(hooks)
  })
  mock.routes.set(`POST /channels/${CHANNEL}/webhooks`, (call) => {
    const created = hook(String(1234567890123456800n + BigInt(hooks.length)), (call.body as { name: string }).name)
    hooks.push(created)
    return Response.json(created)
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const created = () => mock.requests.filter((c) => c.method === 'POST')

function menu(reply: Reply | undefined, index = 0) {
  const control = reply?.components?.[index]?.components[0]
  if (!control) throw new Error('Missing menu control')
  return control
}

describe('/setup', () => {
  it.each(LANGUAGES)('uses Java $code text for menus, descriptions and saved replies', async ({ code }) => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: code })
    const { reply } = await execute(command('setup'), mock)
    expect(reply?.content).toBe(setupReply(code, false))
    for (const [index, group] of ['base', 'modifier'].entries()) {
      const control = menu(reply, index)
      expect(control.placeholder).toBe(coreText(code, `eewbot.scmd.setup.${group}.placeholder`))
      expect(control.options).toHaveLength(index === 0 ? 4 : 1)
      for (const option of control.options ?? []) {
        const key = `eewbot.scmd.setup.${group}.${option.value.toLowerCase()}`
        expect(option.label).toBe(coreText(code, `${key}.label`))
        expect(option.description).toBe(coreText(code, `${key}.desc`))
        expect(option.label.length).toBeLessThanOrEqual(100)
        expect(option.description?.length).toBeLessThanOrEqual(100)
      }
    }
    const intensityMenu = menu(reply, 2)
    expect(intensityMenu.placeholder).toBe(coreText(code, 'eewbot.scmd.setup.sensitivity.placeholder'))
    expect(intensityMenu.options).toHaveLength(10)
    for (const [index, option] of (intensityMenu.options ?? []).entries()) {
      expect(option.label).toBe(
        index === 0
          ? coreText(code, 'eewbot.scmd.setup.sensitivity.option.unknown')
          : formatCoreText(code, 'eewbot.scmd.setup.sensitivity.option', INTENSITIES[index]),
      )
      expect(option.label.length).toBeLessThanOrEqual(100)
    }
    for (const [action, values] of [
      ['b', ['tsunami', 'eewAlert']],
      ['b', []],
      ['m', ['eewDecimation']],
      ['m', []],
      ['i', ['0']],
      ['i', ['5']],
    ] as const) {
      const changed = await execute(component(`eew:${action}`, [...values]), mock)
      expect(changed.reply?.content).toBe(setupFollowup(code, action, [...values]))
    }
    expect((await store.getDestination(CHANNEL))?.lang).toBe(code)
  })

  it('uses the thread language independently of the parent while keeping its own webhook', async () => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'en_us' })
    await seedDestination(env.DB, {
      targetId: THREAD,
      channelId: CHANNEL,
      threadId: THREAD,
      guildId: GUILD,
      lang: 'ko_kp',
    })
    const { reply } = await execute(command('setup', inThread), mock)
    expect(reply?.content).toBe(setupReply('ko_kp', false))
    expect(menu(reply).placeholder).toBe(coreText('ko_kp', 'eewbot.scmd.setup.base.placeholder'))
    expect(hooks[0]?.name).toBe(`EEWBot-${THREAD}`)
  })

  it('registers the channel, creates its webhook and shows the menus', async () => {
    const { ack, reply } = await execute(command('setup'), mock)
    expect(ack).toMatchObject({ type: 5, data: { flags: 64 } })
    const d = await store.getDestination(CHANNEL)
    expect(d).toMatchObject({ guildId: GUILD, channelId: CHANNEL, threadId: null, webhook: { id: hooks[0]?.id } })
    expect(hooks[0]?.name).toBe(`EEWBot-${CHANNEL}`)
    expect(reply?.components?.map((r) => r.components[0]?.custom_id)).toEqual(['eew:b', 'eew:m', 'eew:i'])
  })

  it('gives a thread its own webhook in the parent channel', async () => {
    await execute(command('setup'), mock)
    await execute(command('setup', inThread), mock)
    const thread = await store.getDestination(THREAD)
    expect(thread).toMatchObject({ channelId: CHANNEL, threadId: THREAD })
    expect(hooks.map((h) => h.name)).toEqual([`EEWBot-${CHANNEL}`, `EEWBot-${THREAD}`])
    expect(thread?.webhook?.id).toBe(hooks[1]?.id)
    expect(thread?.webhook?.id).not.toBe((await store.getDestination(CHANNEL))?.webhook?.id)
  })

  it('keeps an existing assignment and reuses a webhook named for the target', async () => {
    await execute(command('setup'), mock)
    await execute(command('setup'), mock)
    expect(created()).toHaveLength(1)

    await store.update({ targetId: CHANNEL, guildId: GUILD, channelId: CHANNEL, threadId: null }, { webhook: null })
    await execute(command('setup'), mock)
    expect(created()).toHaveLength(1)
    expect((await store.getDestination(CHANNEL))?.webhook?.id).toBe(hooks[0]?.id)
  })

  it('ignores webhooks of other applications and creates a new one when the assigned one is gone', async () => {
    hooks.push(hook('1234567890123456700', `EEWBot-${CHANNEL}`, { user: { id: ACTOR } }))
    await seedDestination(env.DB, {
      targetId: CHANNEL,
      guildId: GUILD,
      webhook: { id: '1234567890123456701', token: HOOK_TOKEN },
    })
    await execute(command('setup'), mock)
    expect(created()).toHaveLength(1)
    expect((await store.getDestination(CHANNEL))?.webhook?.id).toBe(hooks[1]?.id)
  })

  it.each(LANGUAGES)('uses the Java $code warning when the bot cannot manage webhooks', async ({ code }) => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: code })
    const { reply } = await execute(command('setup', { app_permissions: String(1024n | 2048n) }), mock)
    expect(mock.requests).toEqual([])
    expect(await store.getDestination(CHANNEL)).toMatchObject({ webhook: null })
    expect(reply?.content).toBe(setupReply(code, true))
  })

  it('requires the bot to view and send in the channel', async () => {
    const { reply } = await execute(command('setup', { app_permissions: '0' }), mock)
    expect(reply?.content).toBe(coreText('ja_jp', 'eewbot.scmd.setup.permserror.viewchannel'))
    expect(await store.getDestination(CHANNEL)).toBeNull()
  })

  it('rejects unsupported channel types', async () => {
    const { reply } = await execute(command('setup', { channel: { type: 2 } }), mock)
    expect(reply?.content).toContain('種類には対応していません')
    expect(await revision(env.DB)).toBe(0)
  })

  it('deletes a created webhook when storing it fails', async () => {
    await env.DB.prepare(`CREATE TRIGGER fail_webhook BEFORE UPDATE OF webhook_id ON destinations
      BEGIN SELECT RAISE(ABORT, 'fail'); END`).run()
    mock.routes.set('DELETE /webhooks/1234567890123456800', () => {
      hooks = []
      return new Response(null, { status: 204 })
    })
    try {
      const { reply } = await execute(command('setup'), mock)
      expect(reply?.content).toContain('失敗')
      expect(hooks).toEqual([])
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_webhook').run()
    }
  })

  it('reports Discord failures', async () => {
    mock.routes.set(`GET /channels/${CHANNEL}/webhooks`, () => new Response(BOT_TOKEN, { status: 403 }))
    const { reply } = await execute(command('setup'), mock)
    expect(reply?.content).toContain('権限が不足')
    expect(JSON.stringify(reply)).not.toContain(BOT_TOKEN)
  })
})

describe('/setup menus', () => {
  const target = { targetId: CHANNEL, guildId: GUILD, channelId: CHANNEL, threadId: null }

  beforeEach(async () => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD })
  })

  it('saves flag groups and intensity for the channel the menu is used in', async () => {
    const { ack, reply } = await execute(component('eew:b', ['eewAlert', 'tsunami']), mock)
    expect(ack.type).toBe(6)
    await execute(component('eew:m', ['eewDecimation']), mock)
    await execute(component('eew:i', ['4']), mock)
    expect(await store.getDestination(CHANNEL)).toMatchObject({
      eewAlert: true,
      eewPrediction: false,
      quakeInfo: false,
      tsunami: true,
      eewDecimation: true,
      minIntensity: 4,
    })
    expect(reply?.content).toBe(setupFollowup('ja_jp', 'b', ['eewAlert', 'tsunami']))
  })

  it('is not invalidated by unrelated configuration changes', async () => {
    const before = await revision(env.DB)
    await seedDestination(env.DB, { targetId: '1234567890123456799', guildId: '2234567890123456789' })
    await execute(component('eew:b', ['quakeInfo']), mock)
    expect((await store.getDestination(CHANNEL))?.quakeInfo).toBe(true)
    expect(await revision(env.DB)).toBe(before + 2)
  })

  it.each([
    ['eew:b', ['unknown']],
    ['eew:i', ['10']],
    ['eew:i', ['1', '2']],
  ])('rejects invalid %s values %j', async (customId, values) => {
    const before = await store.getDestination(CHANNEL)
    const { reply } = await execute(component(customId, values), mock)
    expect(reply?.content).toContain('無効')
    expect(await store.getDestination(CHANNEL)).toEqual(before)
  })

  it('reports an unregistered channel', async () => {
    await store.remove(target)
    const { reply } = await execute(component('eew:b', ['eewAlert']), mock)
    expect(reply?.content).toBe(coreText('ja_jp', 'eewbot.scmd.unregister.notfound'))
  })

  it('requires Manage Guild', async () => {
    const { ack } = await execute(
      component('eew:b', ['eewAlert'], { member: { permissions: '0', user: { id: ACTOR } } }),
      mock,
    )
    expect(ack.data?.content).toContain('サーバー管理権限')
    expect((await store.getDestination(CHANNEL))?.eewAlert).toBe(false)
  })
})

describe('/unregister', () => {
  it.each(LANGUAGES)('uses Java $code text for confirmation, cancel and deletion', async ({ code }) => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: code })
    const { reply } = await execute(command('unregister'), mock)
    expect(reply?.components?.map((r) => r.components[0]?.custom_id)).toEqual(['eew:c', 'eew:x'])
    expect(reply?.content).toBe(coreText(code, 'eewbot.scmd.unregister.confirm'))
    expect(menu(reply).label).toBe(coreText(code, 'eewbot.scmd.unregister.confirm.label'))
    expect(menu(reply, 1).label).toBe(coreText(code, 'eewbot.scmd.unregister.cancel.label'))
    const before = await store.getDestination(CHANNEL)
    const beforeRevision = await revision(env.DB)
    const cancelled = await execute(component('eew:x'), mock)
    expect(cancelled.reply?.content).toBe(coreText(code, 'eewbot.scmd.unregister.cancelled'))
    expect(await store.getDestination(CHANNEL)).toEqual(before)
    expect(await revision(env.DB)).toBe(beforeRevision)
    expect(await store.getDestination(CHANNEL)).not.toBeNull()
    const confirmed = await execute(component('eew:c'), mock)
    expect(confirmed.reply?.content).toBe(coreText(code, 'eewbot.scmd.unregister.done'))
    expect(await store.getDestination(CHANNEL)).toBeNull()
  })

  it('reports an unregistered channel', async () => {
    const { reply } = await execute(command('unregister'), mock)
    expect(reply?.content).toBe(coreText('ja_jp', 'eewbot.scmd.unregister.notfound'))
  })
})

describe('configuration', () => {
  it('requires the bot token', async () => {
    const { reply } = await execute(command('setup'), mock, bindings({ DISCORD_BOT_TOKEN: undefined }))
    expect(reply?.content).toContain('失敗')
    expect(mock.requests).toEqual([])
  })
})
