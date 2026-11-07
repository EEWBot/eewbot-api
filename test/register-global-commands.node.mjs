import assert from 'node:assert/strict'
import { test } from 'node:test'
import { globalCommands, registerGlobalCommands, verifyGlobalCommands } from '../scripts/register-global-commands.mjs'

const APP = '1234567890123456780'
const config = {
  env: {
    staging: { vars: { DISCORD_APPLICATION_ID: APP } },
    production: { vars: { DISCORD_APPLICATION_ID: '2234567890123456780' } },
  },
}
const registered = globalCommands.map((command, index) => ({ ...command, id: String(100 + index) }))

test('plans all seven commands for guilds and bot DMs without network access', async () => {
  const plan = await registerGlobalCommands(config, {}, { environment: 'staging' }, () => {
    assert.fail('A dry run must not make network requests')
  })
  assert.equal(plan.requests.length, 7)
  for (const { body } of plan.requests) {
    assert.deepEqual(body.contexts, [0, 1])
    assert.deepEqual(body.integration_types, [0])
  }
})

test('upserts and verifies guild and bot DM commands', async () => {
  const writes = []
  const result = await registerGlobalCommands(
    config,
    { DISCORD_STAGING_BOT_TOKEN: 'synthetic-bot-token' },
    { environment: 'staging', apply: true },
    async (url, init) => {
      const path = new URL(url).pathname
      if (path === '/api/v10/oauth2/applications/@me') return Response.json({ id: APP })
      assert.equal(path, `/api/v10/applications/${APP}/commands`)
      if (init.method === 'POST') {
        const body = JSON.parse(init.body)
        assert.deepEqual(body.contexts, [0, 1])
        writes.push(body.name)
        return Response.json(registered.find((command) => command.name === body.name))
      }
      assert.equal(init.method, 'GET')
      return Response.json(registered)
    },
  )
  assert.deepEqual(
    writes,
    globalCommands.map((command) => command.name),
  )
  assert.equal(result.commands.length, 7)
})

test('verification rejects missing bot DM support and unsupported private channels', () => {
  for (const contexts of [[0], [0, 1, 2]]) {
    assert.throws(() => verifyGlobalCommands(registered.map((command) => ({ ...command, contexts }))), /verification/)
  }
})
