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
// Discord ignores translations equal to the default, so English is omitted on readback.
const registered = globalCommands.map((command, index) => ({
  ...command,
  description_localizations: Object.fromEntries(
    Object.entries(command.description_localizations).filter(([locale]) => !['en-US', 'en-GB'].includes(locale)),
  ),
  id: String(100 + index),
}))

test('plans all seven commands for guilds and bot DMs without network access', async () => {
  const plan = await registerGlobalCommands(config, {}, { environment: 'staging' }, () => {
    assert.fail('A dry run must not make network requests')
  })
  assert.equal(plan.requests.length, 7)
  for (const { body } of plan.requests) {
    assert.deepEqual(body.contexts, [0, 1])
    assert.deepEqual(body.integration_types, [0])
    assert.deepEqual(
      Object.keys(body.description_localizations).sort(),
      body.name === 'unregister' ? ['en-GB', 'en-US', 'ja'] : ['en-GB', 'en-US', 'ja', 'zh-TW'],
    )
    assert.equal(body.description, body.description_localizations['en-US'])
    assert.equal(body.description_localizations['en-US'], body.description_localizations['en-GB'])
    assert.notEqual(body.description_localizations.ja, body.description)
    for (const description of Object.values(body.description_localizations)) {
      assert.ok(description.length >= 1 && description.length <= 100)
      assert.doesNotMatch(description, /^eewbot\.scmd\./)
    }
  }
  assert.equal(
    plan.requests.find(({ body }) => body.name === 'setup').body.description_localizations['en-US'],
    'Configure the information the bot sends to this channel.',
  )
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
        assert.deepEqual(
          body.description_localizations,
          globalCommands.find((command) => command.name === body.name).description_localizations,
        )
        writes.push(body.name)
        return Response.json(registered.find((command) => command.name === body.name))
      }
      assert.equal(init.method, 'GET')
      assert.equal(new URL(url).searchParams.get('with_localizations'), 'true')
      return Response.json(registered)
    },
  )
  assert.deepEqual(
    writes,
    globalCommands.map((command) => command.name),
  )
  assert.equal(result.commands.length, 7)
  assert.deepEqual(result.commands[0].description_localizations, registered[0].description_localizations)
})

test('verification accepts omitted default translations and arbitrary locale ordering', () => {
  assert.equal(verifyGlobalCommands(registered).length, 7)
  assert.equal(
    verifyGlobalCommands(
      registered.map((command, index) => ({
        ...command,
        description_localizations: Object.fromEntries(
          Object.entries(globalCommands[index].description_localizations).reverse(),
        ),
      })),
    ).length,
    7,
  )
})

test('verification rejects missing or incorrect Japanese and English translations', () => {
  for (const locale of ['ja', 'en-US', 'en-GB']) {
    assert.throws(
      () =>
        verifyGlobalCommands(
          registered.map((command) => ({
            ...command,
            description_localizations: { ...command.description_localizations, [locale]: 'Incorrect translation' },
          })),
        ),
      /verification/,
    )
  }
  for (const localizations of [undefined, null, {}, { 'en-US': registered[0].description }]) {
    assert.throws(
      () =>
        verifyGlobalCommands(registered.map((command) => ({ ...command, description_localizations: localizations }))),
      /verification/,
    )
  }
})

test('verifies available Traditional Chinese translations without requiring untranslated commands', () => {
  assert.equal(
    globalCommands.find((command) => command.name === 'unregister').description_localizations['zh-TW'],
    undefined,
  )
  assert.equal(verifyGlobalCommands(registered).length, 7)
  for (const command of globalCommands.filter((command) => command.name !== 'unregister')) {
    for (const description of [undefined, 'Incorrect translation']) {
      assert.throws(
        () =>
          verifyGlobalCommands(
            registered.map((registeredCommand) =>
              registeredCommand.name === command.name
                ? {
                    ...registeredCommand,
                    description_localizations: { ...registeredCommand.description_localizations, 'zh-TW': description },
                  }
                : registeredCommand,
            ),
          ),
        /verification/,
      )
    }
  }
})

test('requests full localizations again after removing a retired command', async () => {
  let reads = 0
  let deleted = false
  await registerGlobalCommands(
    config,
    { DISCORD_STAGING_BOT_TOKEN: 'synthetic-bot-token' },
    { environment: 'staging', apply: true },
    async (url, init) => {
      const endpoint = new URL(url)
      if (endpoint.pathname === '/api/v10/oauth2/applications/@me') return Response.json({ id: APP })
      if (init.method === 'POST') return Response.json({})
      if (init.method === 'DELETE') {
        assert.equal(endpoint.pathname, `/api/v10/applications/${APP}/commands/999`)
        deleted = true
        return new Response(null, { status: 204 })
      }
      assert.equal(endpoint.searchParams.get('with_localizations'), 'true')
      reads++
      return Response.json(deleted ? registered : [...registered, { name: 'ping', id: '999' }])
    },
  )
  assert.equal(reads, 2)
  assert.equal(deleted, true)
})

test('verification rejects missing bot DM support and unsupported private channels', () => {
  for (const contexts of [[0], [0, 1, 2]]) {
    assert.throws(() => verifyGlobalCommands(registered.map((command) => ({ ...command, contexts }))), /verification/)
  }
})
