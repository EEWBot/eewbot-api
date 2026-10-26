import { Hono } from 'hono'
import { D1DestinationStore } from '../db/d1-destination-store'
import { assertSnowflake } from '../db/destination-validation'
import type { Bindings } from '../env'

export const MAX_CLEANUP_TARGETS = 500
export const MAX_CLEANUP_BYTES = 128 * 1024

const cleanup = new Hono<{ Bindings: Bindings }>()

cleanup.use('*', async (c, next) => {
  // Hono otherwise treats HEAD as GET, including the capability endpoint.
  if (c.req.method !== 'GET' && c.req.method !== 'POST') return c.json({ error: 'not_found' }, 404)
  if (new URL(c.req.url).search !== '') return c.json({ error: 'invalid_cleanup' }, 400)
  await next()
})

cleanup.get('/meta', (c) => c.json({ apiVersion: 1, capabilities: ['destinationCleanup'] }))

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, field)) throw new TypeError()
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_CLEANUP_TARGETS) throw new TypeError()
  return value
}

function ids(value: unknown): string[] {
  return [...new Set(list(value).map((id) => { assertSnowflake(id); return id }))]
}

for (const operation of ['guild', 'destinations', 'webhooks', 'webhook-ids'] as const) {
  cleanup.post(`/${operation}`, async (c) => {
    // Count actual streamed bytes even if Content-Length is absent or misleading.
    const reader = c.req.raw.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_CLEANUP_BYTES) {
            await reader.cancel()
            return c.json({ error: 'body_too_large' }, 413)
          }
          chunks.push(value)
        }
      }
    } catch {
      return c.json({ error: 'invalid_body' }, 400)
    } finally {
      reader?.releaseLock()
    }
    let mutate: (store: D1DestinationStore) => Promise<number>
    try {
      if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new TypeError()
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (operation === 'guild') {
        const guildId = object(payload, 'guildId').guildId
        assertSnowflake(guildId)
        mutate = (store) => store.removeByGuildId(guildId)
      } else if (operation === 'destinations') {
        const targetIds = ids(object(payload, 'targetIds').targetIds)
        mutate = (store) => store.removeDestinations(targetIds)
      } else if (operation === 'webhook-ids') {
        const webhookIds = ids(object(payload, 'webhookIds').webhookIds)
        mutate = (store) => store.clearWebhooksByIds(webhookIds)
      } else {
        const targets = list(object(payload, 'targets').targets).map((value) => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)
              || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'targetId')
              || !Object.hasOwn(value, 'expectedWebhookId')) throw new TypeError()
          const { targetId, expectedWebhookId } = value as Record<string, unknown>
          assertSnowflake(targetId)
          assertSnowflake(expectedWebhookId)
          return { targetId, expectedWebhookId }
        })
        mutate = (store) => store.clearWebhooksByTargets(targets)
      }
    } catch {
      return c.json({ error: 'invalid_cleanup' }, 400)
    }
    if (!c.env.DB) return c.json({ error: 'storage_unavailable' }, 503)
    return c.json({ affected: await mutate(new D1DestinationStore(c.env.DB)) })
  })
}

cleanup.all('*', (c) => c.json({ error: 'not_found' }, 404))

export default cleanup
