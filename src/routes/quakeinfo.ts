import { Hono } from 'hono'
import type { Bindings } from '../env'
import { parseJson, readJson, readJsonText } from '../http/body'
import { ApiError, internalErrorHandler } from '../http/errors'
import { defineRoute } from '../http/route'
import { strictObject, uuid } from '../http/validate'
import { QuakeStore } from '../quakeinfo/store'
import {
  language,
  MAX_CONTROL_BYTES,
  MAX_CREATE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES,
  snapshotInput,
  validateEmbeds,
} from '../quakeinfo/validation'
import { requireDb } from './storage'

const quakeinfo = new Hono<{ Bindings: Bindings }>()
quakeinfo.onError(internalErrorHandler)

function store(env: Bindings): QuakeStore {
  return new QuakeStore(requireDb(env))
}

/** Control endpoints take a small JSON object with exactly the listed keys (default: `{}`). */
async function control(request: Request, keys: readonly string[] = []): Promise<Record<string, unknown>> {
  return strictObject(await readJson(request, MAX_CONTROL_BYTES), keys, { code: 'invalid_quakeinfo' })
}

defineRoute(quakeinfo, '/publisher/lease', {
  POST: async (c) => {
    const { publisherId } = await control(c.req.raw, ['publisherId'])
    return c.json({ publisherEpoch: await store(c.env).lease(uuid(publisherId)) })
  },
})

defineRoute(quakeinfo, '/snapshots', {
  POST: async (c) => {
    const input = await snapshotInput(await readJson(c.req.raw, MAX_CREATE_BYTES))
    await store(c.env).create(input)
    return c.json({ snapshotId: input.snapshotId, status: 'accepted' })
  },
})

defineRoute(quakeinfo, '/snapshots/:id/messages/:lang/:index', {
  PUT: async (c) => {
    const id = uuid(c.req.param('id'))
    const lang = language(c.req.param('lang'))
    const rawIndex = c.req.param('index') ?? ''
    // Canonical decimal only: no signs or leading zeros.
    if (!/^(0|[1-9][0-9]?)$/.test(rawIndex) || Number(rawIndex) >= MAX_MESSAGES) throw new ApiError('invalid_index')
    // Store the exact received text; the manifest hash and length cover these bytes.
    const body = await readJsonText(c.req.raw, MAX_MESSAGE_BYTES)
    validateEmbeds(parseJson(body))
    await store(c.env).put(id, lang, Number(rawIndex), body)
    return c.json({ status: 'accepted' })
  },
})

defineRoute(quakeinfo, '/snapshots/:id/commit', {
  POST: async (c) => {
    const id = uuid(c.req.param('id'))
    await control(c.req.raw)
    return c.json(await store(c.env).commit(id))
  },
})

defineRoute(quakeinfo, '/cleanup', {
  POST: async (c) => {
    await control(c.req.raw)
    await store(c.env).cleanup()
    return c.json({ status: 'ok' })
  },
})

defineRoute(
  quakeinfo,
  '/latest',
  { GET: async (c) => c.json(await store(c.env).latest(language(c.req.query('lang') ?? 'ja_jp'))) },
  { query: ['lang'] },
)

defineRoute(quakeinfo, '/latest/meta', {
  GET: async (c) => c.json(await store(c.env).latestMeta()),
})

export default quakeinfo
