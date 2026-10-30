import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globalCommands, registerGlobalCommands, registrationPlan, parseArguments, verifyGlobalCommands } from '../scripts/register-global-commands.mjs'
import { cleanupGuildCommands } from '../scripts/cleanup-guild-commands.mjs'

const APP = '1234567890123456700', PROD = '1234567890123456701', GUILD = '1234567890123456702'
const config = { env: { staging: { vars: { DISCORD_APPLICATION_ID: APP } }, production: { vars: { DISCORD_APPLICATION_ID: PROD } } } }
const credentials = { DISCORD_STAGING_BOT_TOKEN: 'synthetic-staging' }
const options = { environment: 'staging', apply: true }
const list = () => globalCommands.map((c, i) => ({ ...c, id: String(1234567890123456800n + BigInt(i)) }))
function server(identity = APP) {
  const calls = [], globals = [{ id: '800', name: 'unrelated', type: 1 }, { id: '801', name: 'setup', type: 2 }, { id: '802', name: 'help', type: 3 }]
  let guilds = [...list(), ...globals]
  return { calls, globals, get guilds() { return guilds }, request: async (url, init) => {
    const path = new URL(url).pathname.replace('/api/v10', '')
    calls.push({ path, ...init })
    assert.equal(init.redirect, 'manual')
    assert.ok(init.signal)
    if (path === '/oauth2/applications/@me') return Response.json({ id: identity })
    if (path.endsWith('/guilds/' + GUILD + '/commands')) return Response.json(guilds)
    if (init.method === 'DELETE') {
      guilds = guilds.filter(c => !path.endsWith('/' + c.id)); return new Response(null, { status: 204 })
    }
    if (init.method === 'POST') {
      const c = JSON.parse(init.body), existing = globals.find(d => d.name === c.name && d.type === c.type)
      if (existing) Object.assign(existing, c)
      else globals.push({ ...c, id: String(1234567890123456900n + BigInt(globals.length)) })
      return Response.json(globals.at(-1))
    }
    return Response.json(globals)
  } }
}
test('upserts all eight Global Commands, verifies definitions, preserves unrelated types and remains idempotent', async () => {
  const mock = server()
  for (let i = 0; i < 2; i++) {
    const result = await registerGlobalCommands(config, credentials, options, mock.request)
    assert.equal(result.commands.length, 8)
  }
  assert.equal(mock.globals.length, 11)
  assert.equal(mock.calls.filter(c => c.method === 'POST').length, 16)
  assert.deepEqual(mock.calls.filter(c => c.method !== 'POST').map(c => c.path),
    ['/oauth2/applications/@me', `/applications/${APP}/commands`, '/oauth2/applications/@me', `/applications/${APP}/commands`])
  for (const c of mock.calls.filter(c => c.method === 'POST')) assert.equal(c.path, `/applications/${APP}/commands`)
  assert.ok(mock.calls.every(c => !['PUT', 'DELETE'].includes(c.method)))
  for (const c of globalCommands) {
    assert.equal(c.type, 1); assert.deepEqual(c.integration_types, [0]); assert.deepEqual(c.contexts, [0])
    assert.equal(c.default_member_permissions, ['setup', 'unregister', 'lang'].includes(c.name) ? '32' : null)
  }
})
test('dry runs in both environments never read a token or contact Discord', async () => {
  const noToken = new Proxy({}, { get() { assert.fail('must not inspect credentials') } })
  for (const environment of ['staging', 'production']) {
    const plan = await registerGlobalCommands(config, noToken, { environment }, () => assert.fail('no network'))
    assert.equal(plan.requests.length, 8)
    assert.ok(plan.requests.every(r => r.path === `/applications/${environment === 'staging' ? APP : PROD}/commands`))
  }
})
test('rejects missing/invalid IDs, environment, credentials and environment redirection before networking', async () => {
  const request = () => assert.fail('no network')
  for (const [cfg, creds, opts] of [
    [{}, credentials, options], [config, {}, options], [config, credentials, {}],
    [config, { ...credentials, DISCORD_APPLICATION_ID: PROD }, options],
    [{ env: { staging: { vars: { DISCORD_APPLICATION_ID: PROD } }, production: config.env.production } }, credentials, options],
    [config, credentials, { ...options, commands: ['unknown'] }],
    [config, credentials, { environment: 'production', apply: true }],
    [config, { DISCORD_BOT_TOKEN: 'synthetic' }, { environment: 'production', apply: true, confirmProductionApplication: PROD }],
  ]) await assert.rejects(registerGlobalCommands(cfg, creds, opts, request))
})
test('mismatched token identities cannot write in either environment', async () => {
  for (const [environment, identity, creds, confirmProductionApplication] of [
    ['staging', PROD, credentials, undefined],
    ['production', APP, { DISCORD_PRODUCTION_BOT_TOKEN: 'synthetic-staging' }, PROD],
  ]) {
    const mock = server(identity)
    await assert.rejects(registerGlobalCommands(config, creds, { environment, apply: true, confirmProductionApplication }, mock.request))
    assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0].path, '/oauth2/applications/@me')
  }
})
test('production requests work only with explicit confirmation and a synthetic mock', async () => {
  const mock = server(PROD)
  await registerGlobalCommands(config, { DISCORD_PRODUCTION_BOT_TOKEN: 'synthetic-production' },
    { environment: 'production', apply: true, confirmProductionApplication: PROD }, mock.request)
  assert.ok(mock.calls.slice(1).every(c => c.path === `/applications/${PROD}/commands`))
})
test('supports named subsets and compatibility flags with explicit apply', async () => {
  for (const name of ['testmessage', 'quakeinfo']) {
    const opts = parseArguments(['--env', 'staging', '--apply', `--${name}-only`]), mock = server()
    const result = await registerGlobalCommands(config, credentials, opts, mock.request)
    assert.deepEqual(result.commands.map(c => c.name), [name])
    assert.equal(mock.calls.filter(c => c.method === 'POST').length, 1)
  }
  assert.equal(registrationPlan(config, parseArguments(['--env', 'staging', '--command', 'help'])).requests.length, 1)
  assert.throws(() => parseArguments(['--apply', '--dry-run']))
  assert.throws(() => parseArguments(['--bogus']))
})
test('sanitizes transport errors and HTTP response bodies', async () => {
  for (const request of [() => { throw new Error('synthetic-secret') }, () => new Response('synthetic-secret', { status: 400 })]) {
    await assert.rejects(registerGlobalCommands(config, credentials, options, request), e => !e.message.includes('synthetic-secret'))
  }
})
test('rejects incorrect global definitions before migration', () => {
  for (const change of [{ contexts: [1] }, { integration_types: [1] }, { default_member_permissions: '32' }, { guild_id: GUILD }, { options: [{ name: 'unexpected' }] }]) {
    const commands = list(); Object.assign(commands.find(c => c.name === 'help'), change)
    assert.throws(() => verifyGlobalCommands(commands))
  }
})
test('migration preview prints only known slash IDs/names without deleting', async () => {
  const mock = server(), previews = []
  const result = await cleanupGuildCommands(config, credentials, { environment: 'staging', guildId: GUILD, onPreview: p => previews.push(p) }, mock.request)
  assert.equal(result.candidates.length, 8); assert.equal(previews.length, 1); assert.deepEqual(result.deleted, [])
  assert.ok(mock.calls.every(c => c.method === 'GET'))
})
test('cleanup requires client confirmation and verified globals then individually deletes only owned slash commands', async () => {
  const opts = { environment: 'staging', guildId: GUILD, deleteLegacy: true }
  await assert.rejects(cleanupGuildCommands(config, credentials, opts, () => assert.fail('no network')))
  const mock = server()
  // First install valid globals; cleanup remains a separate explicit operation.
  await registerGlobalCommands(config, credentials, options, mock.request)
  const result = await cleanupGuildCommands(config, credentials, { ...opts, globalClientVerified: true }, mock.request)
  assert.equal(result.deleted.length, 8); assert.equal(result.unrelatedRemaining, 3)
  assert.equal(mock.guilds.length, 3)
  assert.ok(mock.calls.filter(c => c.method === 'DELETE').every(c => c.path.startsWith(`/applications/${APP}/guilds/${GUILD}/commands/`)))
  assert.ok(mock.calls.every(c => c.method !== 'PUT'))
  const missing = server()
  await assert.rejects(cleanupGuildCommands(config, credentials, { ...opts, globalClientVerified: true }, missing.request))
  assert.ok(missing.calls.every(c => c.method !== 'DELETE'))
  await assert.rejects(cleanupGuildCommands(config, credentials, { ...opts, environment: 'production', globalClientVerified: true }, () => assert.fail('no production network')))
})

test('retries only a definite rate limit using the server delay', async () => {
  const mock = server(); let limited = true
  const request = (url, init) => {
    if (init.method === 'POST' && limited) {
      limited = false
      return Response.json({ retry_after: 0 }, { status: 429 })
    }
    return mock.request(url, init)
  }
  assert.equal((await registerGlobalCommands(config, credentials, options, request)).commands.length, 8)
})
test('supports explicitly requested deletion before client verification while still requiring valid globals', async () => {
  const mock = server()
  await registerGlobalCommands(config, credentials, options, mock.request)
  const result = await cleanupGuildCommands(config, credentials, { environment: 'staging', guildId: GUILD,
    deleteLegacy: true, deleteBeforeClientVerification: true }, mock.request)
  assert.equal(result.clientVerified, false)
  assert.equal(result.deleted.length, 8)
  assert.equal(mock.guilds.length, 3)
})
