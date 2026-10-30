import { Hono } from 'hono'
import type { Bindings } from '../env'
import { readJson } from '../http/body'
import { QuakeStore } from '../quakeinfo/store'
import { language, quakeReport } from '../quakeinfo/validation'
import { requireDb } from './storage'

const quakeinfo = new Hono<{ Bindings: Bindings }>()

quakeinfo.put('/latest', async (c) => {
  const report = quakeReport(await readJson(c.req.raw))
  return c.json(await new QuakeStore(requireDb(c.env)).publish(report))
})

quakeinfo.get('/latest', async (c) =>
  c.json(await new QuakeStore(requireDb(c.env)).latest(language(c.req.query('lang') ?? 'ja_jp'))),
)

export default quakeinfo
