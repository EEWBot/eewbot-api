import { Hono } from 'hono'
import type { Bindings } from '../env'
import { QuakeStore } from '../quakeinfo/store'
import { integer, language, MAX_CREATE_BYTES, MAX_MESSAGE_BYTES, MAX_MESSAGES, object, parse,
  QuakeError, readBody, snapshotInput, uuid, validateEmbeds } from '../quakeinfo/validation'

const quakeinfo = new Hono<{ Bindings: Bindings }>()
quakeinfo.use('*', async (c, next) => {
  const query = new URL(c.req.url).searchParams
  if (c.req.method === 'GET' && c.req.path === '/internal/v1/quakeinfo/latest') {
    if ([...query.keys()].some((key) => key !== 'lang') || query.getAll('lang').length > 1) throw new QuakeError('invalid_query')
  } else if (query.size) throw new QuakeError('invalid_query')
  await next()
})
function store(env: Bindings) {
  if (!env.DB) throw new QuakeError('storage_unavailable', 503)
  return new QuakeStore(env.DB)
}
quakeinfo.post('/publisher/lease', async (c) => {
  const v = object(parse(await readBody(c.req.raw, 1024)), ['publisherId'])
  uuid(v.publisherId)
  return c.json({ publisherEpoch: await store(c.env).lease(v.publisherId) })
})
quakeinfo.post('/snapshots', async (c) => {
  const input = await snapshotInput(parse(await readBody(c.req.raw, MAX_CREATE_BYTES)))
  await store(c.env).create(input)
  return c.json({ snapshotId: input.snapshotId, status: 'accepted' })
})
quakeinfo.put('/snapshots/:id/messages/:lang/:index', async (c) => {
  const id = c.req.param('id'); uuid(id)
  const lang = language(c.req.param('lang'))
  const rawIndex = c.req.param('index')
  if (!/^(0|[1-9][0-9]?)$/.test(rawIndex)) throw new QuakeError('invalid_index')
  const index = Number(rawIndex); integer(index, 0, MAX_MESSAGES - 1)
  const body = await readBody(c.req.raw, MAX_MESSAGE_BYTES)
  validateEmbeds(parse(body))
  await store(c.env).put(id,lang,index,body)
  return c.json({ status: 'accepted' })
})
quakeinfo.post('/snapshots/:id/commit', async (c) => {
  const id = c.req.param('id'); uuid(id)
  object(parse(await readBody(c.req.raw, 1024)), [])
  return c.json(await store(c.env).commit(id))
})
quakeinfo.post('/cleanup', async (c) => {
  object(parse(await readBody(c.req.raw, 1024)), [])
  await store(c.env).cleanup()
  return c.json({ status: 'ok' })
})
quakeinfo.get('/latest', async (c) => c.json(await store(c.env).latest(language(c.req.query('lang') ?? 'ja_jp'))))
quakeinfo.get('/latest/meta', async (c) => c.json(await store(c.env).latestMeta()))
quakeinfo.all('*', (c) => c.json({ error: 'not_found' }, 404))
quakeinfo.onError((error, c) => error instanceof QuakeError
  ? c.json({ error: error.code }, error.status, { 'Cache-Control': 'no-store' })
  : c.json({ error: 'storage_unavailable' }, 503, { 'Cache-Control': 'no-store' }))
export default quakeinfo
