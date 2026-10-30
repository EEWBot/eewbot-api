import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers } from '../src/discord/router'
import { app } from '../src/index'

let privateKey: CryptoKey
let publicKeyHex: string
const APP = '1234567890123456780'
const GUILD = '1234567890123456789'
const MANAGE_GUILD = String(1n << 5n)
const context = {
  id: '1234567890123456781',
  application_id: APP,
  guild_id: GUILD,
  channel_id: GUILD,
  context: 0,
  authorizing_integration_owners: { '0': GUILD },
  token: 'test-token',
  member: { permissions: MANAGE_GUILD, user: { id: APP } },
}
const bindings = {
  DISCORD_PUBLIC_KEY: '',
  DISCORD_COMMANDS_ENABLED: 'true',
  DISCORD_APPLICATION_ID: APP,
  DISCORD_BOT_TOKEN: 'synthetic-bot-token',
}

beforeAll(async () => {
  const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  privateKey = keys.privateKey
  publicKeyHex = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
  bindings.DISCORD_PUBLIC_KEY = publicKeyHex
})

beforeEach(() => {
  // Background handlers must never reach the network in these routing tests.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 500 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function signedRequest(
  body: string,
  opts: { timestamp?: string; bodyOverride?: string; signatureOverride?: string; env?: Record<string, string> } = {},
) {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000))
  const input = new TextEncoder().encode(timestamp + body)
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, input)))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
  const ctx = createExecutionContext()
  const response = await app.fetch(
    new Request('http://localhost/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-Ed25519': opts.signatureOverride ?? signature,
        'X-Signature-Timestamp': timestamp,
      },
      body: opts.bodyOverride ?? body,
    }),
    { ...bindings, ...opts.env },
    ctx,
  )
  await waitOnExecutionContext(ctx)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  return response
}

type Payload = { type: number; data?: { flags?: number; content?: string; embeds?: unknown[] } }

describe('Discord HTTP Interactions', () => {
  it('provides a public non-sensitive health endpoint', async () => {
    const response = await app.request('http://localhost/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('answers unknown routes with a JSON 404', async () => {
    const response = await app.request('http://localhost/nope')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'not_found' } })
  })

  it('acknowledges an authenticated Discord PING', async () => {
    const response = await signedRequest('{"type":1}')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 1 })
  })

  it.each(['ping', 'not-migrated'])('answers the unsupported command /%s ephemerally', async (name) => {
    const response = await signedRequest(JSON.stringify({ ...context, type: 2, data: { name } }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as Payload
    expect(payload.type).toBe(4)
    expect(payload.data?.flags).toBe(64)
  })

  it('answers unsupported components and modals ephemerally', async () => {
    for (const body of [
      { ...context, type: 3, data: { custom_id: 'test:ping', component_type: 2 } },
      { ...context, type: 5, data: { custom_id: 'modal' } },
    ]) {
      const payload = (await (await signedRequest(JSON.stringify(body))).json()) as Payload
      expect(payload).toMatchObject({ type: 4, data: { flags: 64 } })
    }
  })

  it('returns an empty autocomplete result', async () => {
    const response = await signedRequest(JSON.stringify({ type: 4, data: { name: 'unknown' } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 8, data: { choices: [] } })
  })

  it('rejects an unknown interaction type', async () => {
    const response = await signedRequest(JSON.stringify({ type: 99 }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'unsupported_interaction_type' } })
  })

  it('rejects tampered bodies even when the original payload was signed', async () => {
    const response = await signedRequest('{"type":1}', { bodyOverride: '{"type":2}' })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: 'invalid_signature' } })
  })

  it('rejects syntactically invalid signatures', async () => {
    const response = await signedRequest('{"type":1}', { signatureOverride: 'invalid' })
    expect(response.status).toBe(401)
  })

  it('rejects old signed requests', async () => {
    const response = await signedRequest('{"type":1}', { timestamp: String(Math.floor(Date.now() / 1000) - 600) })
    expect(response.status).toBe(401)
  })

  it.each([
    ['{broken json', 'invalid_json'],
    ['[1]', 'invalid_interaction'],
    ['{"type":"1"}', 'invalid_interaction'],
  ])('rejects signed invalid payload %s', async (body, code) => {
    const response = await signedRequest(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code } })
  })

  it('fails closed when the public key is missing', async () => {
    const response = await app.request('http://localhost/interactions', { method: 'POST', body: '{"type":1}' }, {})
    expect(response.status).toBe(503)
  })
})

describe('Interaction dispatch table', () => {
  it('routes every command to exactly one handler', () => {
    for (const name of ['setup', 'unregister', 'lang', 'help', 'invite', 'testmessage', 'quakeinfo']) {
      const matching = handlers.filter((h) => h.matches({ type: 2, data: { name } }))
      expect(matching, name).toHaveLength(1)
    }
  })

  it.each([
    ['quakeinfo', { type: 5 }],
    ['testmessage', { type: 5, data: { flags: 64 } }],
    ['setup', { type: 5, data: { flags: 64 } }],
    ['unregister', { type: 5, data: { flags: 64 } }],
    ['lang', { type: 5, data: { flags: 64 } }],
    ['invite', { type: 4, data: { flags: 64 } }],
  ])('acknowledges /%s with %j', async (name, expected) => {
    const payload = (await (
      await signedRequest(JSON.stringify({ ...context, type: 2, data: { name } }))
    ).json()) as Payload
    expect(payload).toMatchObject(expected)
    if (name === 'quakeinfo') expect(payload.data?.flags).toBeUndefined()
  })

  it('answers /help publicly with an embed', async () => {
    const payload = (await (
      await signedRequest(JSON.stringify({ ...context, type: 2, data: { name: 'help' } }))
    ).json()) as Payload
    expect(payload.type).toBe(4)
    expect(payload.data?.flags).toBeUndefined()
    expect(payload.data?.embeds).toHaveLength(1)
  })

  it.each(['eew:', 'eewlang:'])('acknowledges %s components with a deferred update', async (prefix) => {
    const body = { ...context, type: 3, data: { custom_id: `${prefix}${'a'.repeat(32)}:x`, component_type: 2 } }
    expect(await (await signedRequest(JSON.stringify(body))).json()).toEqual({ type: 6 })
  })

  it('requires Manage Guild for settings commands but not for member commands', async () => {
    const member = { ...context, member: { permissions: '0', user: { id: APP } } }
    const setup = (await (
      await signedRequest(JSON.stringify({ ...member, type: 2, data: { name: 'setup' } }))
    ).json()) as Payload
    expect(setup).toMatchObject({ type: 4, data: { flags: 64, content: 'サーバー管理権限が必要です。' } })
    const invite = (await (
      await signedRequest(JSON.stringify({ ...member, type: 2, data: { name: 'invite' } }))
    ).json()) as Payload
    expect(invite.data?.content).toContain('EEWBot')
  })

  it('denies every command while commands are disabled', async () => {
    const payload = (await (
      await signedRequest(JSON.stringify({ ...context, type: 2, data: { name: 'help' } }), {
        env: { DISCORD_COMMANDS_ENABLED: 'false' },
      })
    ).json()) as Payload
    expect(payload).toMatchObject({ type: 4, data: { flags: 64, content: 'コマンドは現在無効です。' } })
  })

  it('answers with an ephemeral start failure when background work cannot be scheduled', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({ ...context, type: 2, data: { name: 'testmessage' } })
    const signature = Array.from(
      new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(timestamp + body))),
    )
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('')
    // No ExecutionContext: waitUntil() is unavailable.
    const response = await app.request(
      'http://localhost/interactions',
      {
        method: 'POST',
        headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
        body,
      },
      bindings,
    )
    expect(await response.json()).toMatchObject({
      type: 4,
      data: { flags: 64, content: 'テスト送信を開始できません。' },
    })
    // No background work may start when it cannot be scheduled.
    expect(fetch).not.toHaveBeenCalled()
  })
})
