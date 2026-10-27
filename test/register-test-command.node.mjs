import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTestCommands } from '../scripts/register-test-command.mjs'

const vars = { DISCORD_APPLICATION_ID: '1234567890123456700', DISCORD_TEST_GUILD_ID: '1234567890123456701' }
const config = { env: { staging: { vars } } }
test('upserts the four test guild commands individually and preserves unrelated commands', async () => {
  const calls = []
  await registerTestCommands(config, { DISCORD_BOT_TOKEN: 'synthetic' }, async (url, init) => {
    calls.push({ url, ...init })
    return Response.json({ id: vars.DISCORD_APPLICATION_ID })
  })
  assert.equal(calls.length, 5)
  assert.match(calls[0].url, /oauth2\/applications\/@me$/)
  for (const call of calls.slice(1)) {
    assert.equal(call.url, `https://discord.com/api/v10/applications/${vars.DISCORD_APPLICATION_ID}/guilds/${vars.DISCORD_TEST_GUILD_ID}/commands`)
    assert.equal(call.method, 'POST')
    assert.equal(call.redirect, 'manual')
  }
  const commands = calls.slice(1).map((call) => JSON.parse(call.body))
  assert.deepEqual(commands.map((c) => c.name), ['ping', 'setup', 'unregister', 'lang'])
  assert.equal(commands[1].default_member_permissions, '32')
  assert.equal(commands[2].default_member_permissions, '32')
  assert.equal(commands[3].default_member_permissions, '32')
})
test('fails closed without pinned staging IDs or token and rejects environment redirection', async () => {
  const request = () => assert.fail('must not reach Discord')
  for (const [cfg, environment] of [[{}, { DISCORD_BOT_TOKEN: 'synthetic' }], [config, {}],
    [config, { DISCORD_BOT_TOKEN: 'synthetic', DISCORD_APPLICATION_ID: '999' }],
    [config, { DISCORD_BOT_TOKEN: 'synthetic', DISCORD_TEST_GUILD_ID: '999' }]]) {
    await assert.rejects(registerTestCommands(cfg, environment, request))
  }
})
test('checks token application identity before any command write', async () => {
  let calls = 0
  await assert.rejects(registerTestCommands(config, { DISCORD_BOT_TOKEN: 'synthetic' }, async () => {
    calls++
    return Response.json({ id: '999' })
  }))
  assert.equal(calls, 1)
})
test('sanitizes token-bearing transport errors', async () => {
  await assert.rejects(registerTestCommands(config, { DISCORD_BOT_TOKEN: 'synthetic-secret' }, () => {
    throw new Error('https://discord.com/api/webhooks/1/synthetic-secret')
  }), (error) => !error.message.includes('synthetic-secret'))
})
