import { Hono } from 'hono'
import { D1DestinationStore } from '../db/d1-destination-store'
import type { Destination, Intensity } from '../db/destination-types'
import type { Bindings } from '../env'
import { readJson } from '../http/body'
import { ApiError } from '../http/errors'
import { boundedArray, INVALID_REQUEST, integer, object, snowflake } from '../http/validate'
import { isLanguageCode } from '../i18n/languages'
import { requireDb } from './storage'

export const MAX_IMPORT_DESTINATIONS = 500

/** Same rule as Core's snapshot reader: one token it rejects would stop all delivery. */
const WEBHOOK_TOKEN = /^[A-Za-z0-9_-]{20,256}$/

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ApiError(INVALID_REQUEST)
  return value
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value)
}

function destination(value: unknown): Destination {
  const d = object(value)
  const targetId = snowflake(d.targetId)
  const channelId = snowflake(d.channelId)
  const threadId = nullable(d.threadId, snowflake)
  // The same target identity rules as the destinations CHECKs.
  if (threadId === null ? channelId !== targetId : threadId !== targetId || channelId === targetId) {
    throw new ApiError(INVALID_REQUEST)
  }
  integer(d.minIntensity, 0, 9)
  if (!isLanguageCode(d.lang)) throw new ApiError(INVALID_REQUEST)
  const webhook = nullable(d.webhook, (value) => {
    const hook = object(value)
    if (typeof hook.token !== 'string' || !WEBHOOK_TOKEN.test(hook.token)) throw new ApiError(INVALID_REQUEST)
    return { id: snowflake(hook.id), token: hook.token }
  })
  return {
    targetId,
    channelId,
    threadId,
    guildId: nullable(d.guildId, snowflake),
    eewAlert: boolean(d.eewAlert),
    eewPrediction: boolean(d.eewPrediction),
    eewDecimation: boolean(d.eewDecimation),
    quakeInfo: boolean(d.quakeInfo),
    tsunami: boolean(d.tsunami),
    minIntensity: d.minIntensity as Intensity,
    lang: d.lang,
    webhook,
  }
}

const migration = new Hono<{ Bindings: Bindings }>()

/** One-off import of the legacy Java Core store, in chunks. Upserts by targetId. */
migration.post('/destinations', async (c) => {
  const destinations = boundedArray(object(await readJson(c.req.raw)).destinations, MAX_IMPORT_DESTINATIONS).map(
    destination,
  )
  if (new Set(destinations.map((d) => d.targetId)).size !== destinations.length) throw new ApiError(INVALID_REQUEST)
  return c.json({ affected: await new D1DestinationStore(requireDb(c.env)).importDestinations(destinations) })
})

export default migration
