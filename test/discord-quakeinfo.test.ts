import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bindings } from '../src/env'
import { coreText } from '../src/i18n/core'
import { LANGUAGES } from '../src/i18n/languages'
import { quakeInfoText } from '../src/i18n/quakeinfo'
import { QuakeStore } from '../src/quakeinfo/store'
import { quakeReport } from '../src/quakeinfo/validation'
import {
  ACTOR,
  APP,
  bindings,
  CHANNEL,
  command,
  DiscordMock,
  execute,
  GUILD,
  inThread,
  THREAD,
} from './support/discord'
import { resetDb, revision, seedDestination } from './support/fixtures'

let mock: DiscordMock
let followups: unknown[]

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
beforeEach(async () => {
  await resetDb(env.DB)
  followups = []
  mock = new DiscordMock().install()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function published(overrides: Record<string, unknown> = {}, pages = 3) {
  await new QuakeStore(env.DB).publish(
    quakeReport({
      eventId: '20260101000000',
      reportType: 'VXSE53',
      reportDateTime: new Date().toISOString(),
      dateTime: null,
      serial: 1,
      infoType: '発表',
      languages: Object.fromEntries(
        LANGUAGES.map(({ code }) => [code, Array.from({ length: pages }, (_, i) => [{ title: `${code} ${i}` }])]),
      ),
      ...overrides,
    }),
  )
}

function followupRoute(token: string, respond: () => Response = () => Response.json({})) {
  mock.routes.set(`POST /webhooks/${APP}/${token}`, (call) => {
    expect(call.url.search).toBe('?wait=true')
    expect(call.headers.get('Authorization')).toBeNull()
    followups.push(call.body)
    return respond()
  })
}

describe('/quakeinfo', () => {
  it('lets an ordinary member post the latest report publicly, page by page', async () => {
    await published()
    const payload = command('quakeinfo', { member: { permissions: '0', user: { id: ACTOR } } })
    followupRoute(payload.token ?? '')
    const { ack, reply } = await execute(payload, mock)
    expect(ack).toEqual({ type: 5, data: { allowed_mentions: { parse: [] } } })
    expect(reply?.embeds).toEqual([{ title: 'ja_jp 0' }])
    expect(reply?.content).toContain(quakeInfoText.ja_jp.report)
    expect(reply?.content).not.toContain(quakeInfoText.ja_jp.old)
    expect(followups).toEqual([
      { embeds: [{ title: 'ja_jp 1' }], allowed_mentions: { parse: [] } },
      { embeds: [{ title: 'ja_jp 2' }], allowed_mentions: { parse: [] } },
    ])
    expect(await revision(env.DB)).toBe(0)
  })

  it.each(LANGUAGES)('uses the channel language $code', async ({ code }) => {
    await published({}, 1)
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: code })
    const { reply } = await execute(command('quakeinfo'), mock)
    expect(reply?.embeds).toEqual([{ title: `${code} 0` }])
  })

  it('uses the thread language independently of its parent', async () => {
    await published({}, 1)
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: 'en_us' })
    await seedDestination(env.DB, {
      targetId: THREAD,
      channelId: CHANNEL,
      threadId: THREAD,
      guildId: GUILD,
      lang: 'zh_tw',
    })
    const { reply } = await execute(command('quakeinfo', inThread), mock)
    expect(reply?.embeds).toEqual([{ title: 'zh_tw 0' }])
  })

  it('marks an old report', async () => {
    await published({ reportDateTime: '2020-01-01T00:00:00Z' }, 1)
    const { reply } = await execute(command('quakeinfo'), mock)
    expect(reply?.content).toContain(quakeInfoText.ja_jp.old)
  })

  it.each(LANGUAGES)('answers with the Java $code no-data message before the first publication', async ({ code }) => {
    await seedDestination(env.DB, { targetId: CHANNEL, guildId: GUILD, lang: code })
    const { reply } = await execute(command('quakeinfo'), mock)
    expect(reply?.content).toBe(coreText(code, 'eewbot.scmd.quakeinfo.error'))
  })

  it('keeps the first page and never resends when a follow-up fails', async () => {
    await published()
    const payload = command('quakeinfo')
    followupRoute(payload.token ?? '', () => new Response('', { status: 500 }))
    const { reply } = await execute(payload, mock)
    expect(followups).toHaveLength(1)
    expect(reply?.embeds).toEqual([{ title: 'ja_jp 0' }])
    expect(reply?.content).toContain(quakeInfoText.ja_jp.partial)
  })

  it('answers with an error when storage is unavailable', async () => {
    const DB = {
      prepare: () => {
        throw new Error('secret')
      },
    } as unknown as Bindings['DB']
    const { reply } = await execute(command('quakeinfo'), mock, bindings({ DB }))
    expect(reply?.content).toBe(quakeInfoText.ja_jp.error)
  })
})
