import { Hono } from 'hono'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Bindings } from '../env'
import { readJson } from '../http/body'
import { boundedArray, object, snowflake } from '../http/validate'
import { requireDb } from './storage'

export const MAX_CLEANUP_TARGETS = 500

type Mutation = (store: D1DestinationStore) => Promise<number>

/** Deduplicated snowflakes; the length limit applies before deduplication. */
function snowflakes(value: unknown): string[] {
  return [...new Set(boundedArray(value, MAX_CLEANUP_TARGETS).map((id) => snowflake(id)))]
}

/** Each operation validates the whole request before returning its storage mutation. */
const operations: Record<string, (payload: Record<string, unknown>) => Mutation> = {
  guild: ({ guildId }) => {
    const id = snowflake(guildId)
    return (store) => store.removeByGuildId(id)
  },
  destinations: ({ targetIds }) => {
    const ids = snowflakes(targetIds)
    return (store) => store.removeDestinations(ids)
  },
  webhooks: ({ targets }) => {
    const pairs = boundedArray(targets, MAX_CLEANUP_TARGETS).map((value) => {
      const target = object(value)
      return { targetId: snowflake(target.targetId), expectedWebhookId: snowflake(target.expectedWebhookId) }
    })
    return (store) => store.clearWebhooksByTargets(pairs)
  },
  'webhook-ids': ({ webhookIds }) => {
    const ids = snowflakes(webhookIds)
    return (store) => store.clearWebhooksByIds(ids)
  },
}

const cleanup = new Hono<{ Bindings: Bindings }>()

for (const [name, parse] of Object.entries(operations)) {
  cleanup.post(`/${name}`, async (c) => {
    const mutate = parse(object(await readJson(c.req.raw)))
    return c.json({ affected: await mutate(new D1DestinationStore(requireDb(c.env))) })
  })
}

export default cleanup
