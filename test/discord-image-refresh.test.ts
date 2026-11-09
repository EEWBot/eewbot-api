import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IMAGE_REFRESH_CUSTOM_ID } from '../src/discord/image-refresh'
import { dispatch } from '../src/discord/router'
import { apiText } from '../src/i18n/api'
import { ACTOR, APP, bindings, component, DiscordMock, execute, inDm, inThread } from './support/discord'

let mock: DiscordMock
beforeEach(() => {
  mock = new DiscordMock().install()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

it.each([{}, inThread, inDm])(
  'refreshes the clicked message without storage, a bot token or admin permissions: %j',
  async (context) => {
    const payload = component(IMAGE_REFRESH_CUSTOM_ID, undefined, {
      member: { permissions: '0', user: { id: ACTOR } },
      ...context,
    })
    const { ack, reply } = await execute(payload, mock, bindings({ DB: undefined, DISCORD_BOT_TOKEN: undefined }))
    expect(ack).toEqual({ type: 6 })
    // Omitting all other fields preserves content, embeds, attachments and flags.
    expect(reply).toEqual({ components: [] })
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].method).toBe('PATCH')
    expect(mock.calls[0].url.pathname).toBe(`/api/v10/webhooks/${APP}/${payload.token}/messages/@original`)
    expect(mock.calls[0].headers.get('Authorization')).toBeNull()
  },
)

it('reports an edit failure privately without replacing the notification', async () => {
  const payload = component(IMAGE_REFRESH_CUSTOM_ID, undefined, { locale: 'en-US' })
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 403 }))
  mock.routes.set(`POST /webhooks/${APP}/${payload.token}`, () => Response.json({}))
  const { ack, reply } = await execute(payload, mock)
  expect(ack).toEqual({ type: 6 })
  expect(reply).toBeUndefined()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(vi.mocked(fetch).mock.calls.map(([, init]) => [init?.method, JSON.parse(String(init?.body))])).toEqual([
    ['PATCH', { components: [] }],
    ['POST', { content: apiText('en_us').discord.forbidden, flags: 64, allowed_mentions: { parse: [] } }],
  ])
})

it('retries a transient edit failure once with the same partial payload', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({}, { status: 500 }))
  const { reply } = await execute(component(IMAGE_REFRESH_CUSTOM_ID), mock)
  expect(reply).toEqual({ components: [] })
  expect(mock.calls).toHaveLength(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const [, init] of vi.mocked(fetch).mock.calls) {
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ components: [] })
  }
})

it.each([
  component(IMAGE_REFRESH_CUSTOM_ID, undefined, { application_id: '1234567890123456700' }),
  component(`${IMAGE_REFRESH_CUSTOM_ID}:unknown`),
  component(IMAGE_REFRESH_CUSTOM_ID, ['unexpected']),
  component(IMAGE_REFRESH_CUSTOM_ID, undefined, { type: 2 }),
])('rejects unrelated or unauthorized interactions without editing: %j', async (payload) => {
  const { ack } = await execute(payload, mock)
  expect(ack).toMatchObject({ type: 4, data: { flags: 64 } })
  expect(mock.calls).toEqual([])
})

it('does not start an edit if background work cannot be scheduled', async () => {
  const ack = await dispatch(component(IMAGE_REFRESH_CUSTOM_ID), bindings(), () => {
    throw new Error('no execution context')
  })
  expect(ack).toMatchObject({
    type: 4,
    data: { flags: 64, content: '画像の再読み込みを開始できません。' },
  })
  expect(mock.calls).toEqual([])
})
