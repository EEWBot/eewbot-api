import { Hono } from 'hono'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Bindings } from '../env'
import { readJson } from '../http/body'
import { internalErrorHandler } from '../http/errors'
import { defineRoute } from '../http/route'
import { boundedArray, snowflake, strictObject } from '../http/validate'
import { requireDb } from './storage'

export const MAX_CLEANUP_TARGETS = 500
export const MAX_CLEANUP_BYTES = 128 * 1024

type Mutation = (store: D1DestinationStore) => Promise<number>

/** Reads `{ "<name>": ... }` with exactly that one field. */
function field(payload: unknown, name: string): unknown {
  return strictObject(payload, [name])[name]
}

/** Deduplicated snowflakes; the length limit applies before deduplication. */
function snowflakes(value: unknown): string[] {
  return [...new Set(boundedArray(value, MAX_CLEANUP_TARGETS).map((id) => snowflake(id)))]
}

/** Each operation validates the whole request before returning its storage mutation. */
const operations: Record<string, (payload: unknown) => Mutation> = {
  guild: (payload) => {
    const guildId = snowflake(field(payload, 'guildId'))
    return (store) => store.removeByGuildId(guildId)
  },
  destinations: (payload) => {
    const targetIds = snowflakes(field(payload, 'targetIds'))
    return (store) => store.removeDestinations(targetIds)
  },
  webhooks: (payload) => {
    const targets = boundedArray(field(payload, 'targets'), MAX_CLEANUP_TARGETS).map((value) => {
      const target = strictObject(value, ['targetId', 'expectedWebhookId'])
      return { targetId: snowflake(target.targetId), expectedWebhookId: snowflake(target.expectedWebhookId) }
    })
    return (store) => store.clearWebhooksByTargets(targets)
  },
  'webhook-ids': (payload) => {
    const webhookIds = snowflakes(field(payload, 'webhookIds'))
    return (store) => store.clearWebhooksByIds(webhookIds)
  },
}

const cleanup = new Hono<{ Bindings: Bindings }>()
cleanup.onError(internalErrorHandler)

defineRoute(cleanup, '/meta', {
  GET: (c) => c.json({ apiVersion: 2, capabilities: ['destinationCleanup'] }),
})

for (const [name, parse] of Object.entries(operations)) {
  defineRoute(cleanup, `/${name}`, {
    POST: async (c) => {
      const mutate = parse(await readJson(c.req.raw, MAX_CLEANUP_BYTES))
      const affected = await mutate(new D1DestinationStore(requireDb(c.env)))
      return c.json({ affected })
    },
  })
}

export default cleanup
