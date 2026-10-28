import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Real loopback HTTP server exercises redirects, sockets, streaming and aborts.
// This test adapter maps fixed HTTPS endpoints to loopback; production has no HTTP override.
const realFetch = globalThis.fetch
const target = { targetId: '1234567890123456780', channelId: '1234567890123456780', guildId: '1234567890123456781', threadId: null }
const webhook = 'https://discord.com/api/webhooks/1234567890123456782/synthetic-webhook-token'
const settings = { DISCORD_BOT_TOKEN: 'synthetic-bot', WEBHOOK_SENDER_URL: 'https://sender.example.com',
  WEBHOOK_SENDER_ACCESS_CLIENT_ID: 'synthetic-client', WEBHOOK_SENDER_ACCESS_CLIENT_SECRET: 'synthetic-client-secret',
  WEBHOOK_SENDER_AUTH_TOKEN: 'synthetic-bearer' }
const body = { embeds: [{ title: 'test', description: 'test', color: 7506394 }], allowed_mentions: { parse: [] } }
let delivery, server, origin, status, content, mode, observed
before(async () => {
  const output = new URL('../.wrangler/testmessage-http/', import.meta.url)
  await mkdir(output, { recursive: true })
  const bundle = fileURLToPath(new URL('delivery.mjs', output))
  await build({ entryPoints: [fileURLToPath(new URL('../src/discord/testmessage-delivery.ts', import.meta.url))],
    outfile: bundle, bundle: true, platform: 'node', format: 'esm' })
  delivery = await import(pathToFileURL(bundle).href)
  server = createServer(async (req, res) => {
    let data = ''
    for await (const chunk of req) data += chunk
    observed.push({ path: req.url, headers: req.headers, body: JSON.parse(data || 'null') })
    if (mode === 'disconnect') { req.socket.destroy(); return }
    if (mode === 'stall-headers') return
    res.writeHead(status, { 'Content-Type': 'text/plain', ...(status >= 300 && status < 400 ? { Location: origin + '/trap' } : {}) })
    if (mode === 'stall-body') { res.write('O'); return }
    res.end(mode === 'oversized' ? 'x'.repeat(65537) : content)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  globalThis.fetch = (url, init) => {
    const parsed = new URL(url)
    assert.ok(['https://discord.com', 'https://sender.example.com'].includes(parsed.origin))
    assert.equal(init.redirect, 'manual')
    // Each case owns a socket, including after deliberate abort/destroy cases.
    // Avoid the next case racing reuse of a just-destroyed pooled connection.
    return realFetch(origin + parsed.pathname + parsed.search, { ...init,
      headers: { ...init.headers, Connection: 'close' } })
  }
})
after(async () => {
  globalThis.fetch = realFetch
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})
beforeEach(() => { status = 200; content = 'OK'; mode = 'normal'; observed = [] })

for (const route of ['webhook', 'webhooksender', 'nowebhook']) {
  const run = () => delivery.deliverTestMessage({ route, webhook: route === 'nowebhook' ? null : webhook,
    sender: route === 'webhooksender' ? delivery.senderConfiguration(settings) : null }, settings, target, body, Date.now() + 5000)
  for (const code of [200, 204, 301, 302, 307, 308, 400, 401, 403, 404, 429, 500, 502, 503]) {
    test(`real HTTP ${route} ${code}: one request, safe headers and correct outcome`, async () => {
      status = code
      if (code === 200 || code === 204 && route !== 'webhooksender') await run()
      else await assert.rejects(run())
      assert.equal(observed.length, 1)
      const request = observed[0]
      if (route === 'webhooksender') {
        assert.equal(request.path, '/api/send')
        assert.equal(request.headers.authorization, 'Bearer synthetic-bearer')
        assert.equal(request.headers['cf-access-client-id'], 'synthetic-client')
        assert.equal(request.headers['cf-access-client-secret'], 'synthetic-client-secret')
        assert.deepEqual(request.body, [{ targets: [webhook], body, retry_limit: 10 }])
      } else {
        assert.equal(request.headers['cf-access-client-id'], undefined)
        assert.equal(request.headers['cf-access-client-secret'], undefined)
        assert.equal(request.headers.authorization, route === 'nowebhook' ? 'Bot synthetic-bot' : undefined)
        assert.deepEqual(request.body, body)
        if (route === 'webhook') assert.ok(request.path.endsWith('?wait=true'))
      }
    })
  }
  for (const failure of ['disconnect', 'oversized', 'stall-headers', 'stall-body']) {
    test(`real HTTP ${route} ${failure}: bounded failure without retry`, async () => {
      mode = failure
      const start = Date.now()
      await assert.rejects(run(), error => ['connection', 'timeout', 'oversized'].includes(error.kind))
      assert.ok(Date.now() - start < 4500)
      assert.equal(observed.length, 1)
      server.closeAllConnections()
    })
  }
}
