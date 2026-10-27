import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'

let privateKey: CryptoKey
let publicKeyHex: string
const APP = '1234567890123456780', GUILD = '1234567890123456789'
const context = { id: '1234567890123456781', application_id: APP, guild_id: GUILD, channel_id: GUILD,
  context: 0, authorizing_integration_owners: { '0': GUILD }, token: 'test-token', member: { permissions: '0', user: { id: APP } } }

beforeAll(async () => {
  const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  privateKey = keys.privateKey
  publicKeyHex = Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
})

async function signedRequest(
  body: string,
  opts: { timestamp?: string; bodyOverride?: string; signatureOverride?: string; publicKeyOverride?: string } = {},
) {
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000))
  const input = new TextEncoder().encode(timestamp + body)
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, input)))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
  return app.request(
    'http://localhost/interactions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-Ed25519': opts.signatureOverride ?? signature,
        'X-Signature-Timestamp': timestamp,
      },
      body: opts.bodyOverride ?? body,
    },
    { DISCORD_PUBLIC_KEY: opts.publicKeyOverride ?? publicKeyHex, DISCORD_COMMANDS_ENABLED: 'true', DISCORD_APPLICATION_ID: APP, DISCORD_TEST_GUILD_ID: GUILD },
  )
}

describe('Discord HTTP Interactions', () => {
  it('provides a public non-sensitive health endpoint', async () => {
    const response = await app.request('http://localhost/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it('acknowledges an authenticated Discord PING', async () => {
    const response = await signedRequest('{"type":1}')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 1 })
  })

  it('responds to /ping with an ephemeral message and a test button', async () => {
    const response = await signedRequest(JSON.stringify({
      ...context, type: 2,
      data: { name: 'ping' },
    }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      type: number
      data: { content: string; flags: number; components: { components: { custom_id: string }[] }[] }
    }
    expect(payload.type).toBe(4)
    expect(payload.data.flags).toBe(64)
    expect(payload.data.content).toContain('Pong')
    expect(payload.data.components[0].components[0].custom_id).toBe('test:ping')
  })

  it('responds to the test button', async () => {
    const response = await signedRequest(JSON.stringify({ ...context, type: 3, data: { custom_id: 'test:ping', component_type: 2 } }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { type: number; data: { flags: number; content: string } }
    expect(payload.type).toBe(4)
    expect(payload.data.flags).toBe(64)
    expect(payload.data.content).toContain('Button')
  })

  it('does not leave unknown interactions waiting for an acknowledgement', async () => {
    const response = await signedRequest(JSON.stringify({ type: 2, data: { name: 'not-migrated' } }))
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { type: number; data: { flags: number } }
    expect(payload.type).toBe(4)
    expect(payload.data.flags).toBe(64)
  })

  it('returns an empty autocomplete result', async () => {
    const response = await signedRequest(JSON.stringify({ type: 4, data: { name: 'unknown' } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 8, data: { choices: [] } })
  })

  it('rejects tampered bodies even when the original payload was signed', async () => {
    const response = await signedRequest('{"type":1}', { bodyOverride: '{"type":2}' })
    expect(response.status).toBe(401)
  })

  it('rejects syntactically invalid signatures', async () => {
    const response = await signedRequest('{"type":1}', { signatureOverride: 'invalid' })
    expect(response.status).toBe(401)
  })

  it('rejects old signed requests', async () => {
    const response = await signedRequest('{"type":1}', {
      timestamp: String(Math.floor(Date.now() / 1000) - 600),
    })
    expect(response.status).toBe(401)
  })

  it('rejects signed invalid JSON', async () => {
    const response = await signedRequest('{broken json')
    expect(response.status).toBe(400)
  })

  it('fails closed when the public key is missing', async () => {
    const response = await app.request(
      'http://localhost/interactions',
      { method: 'POST', body: '{"type":1}' },
      {},
    )
    expect(response.status).toBe(503)
  })
})
