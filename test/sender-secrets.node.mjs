import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('keeps the private Sender origin and credentials out of public Wrangler vars', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
  const names = ['WEBHOOK_SENDER_URL', 'WEBHOOK_SENDER_ACCESS_CLIENT_ID',
    'WEBHOOK_SENDER_ACCESS_CLIENT_SECRET', 'WEBHOOK_SENDER_AUTH_TOKEN']
  for (const environment of [config, ...Object.values(config.env ?? {})]) {
    for (const name of names) {
      // Report only the binding name, never a private value on failure.
      assert.equal(Object.hasOwn(environment.vars ?? {}, name), false, `${name} must be a Worker Secret`)
    }
  }
})
