import { LANGUAGES, isLanguageCode, type LanguageCode } from '../i18n/languages'

export const MAX_MESSAGE_BYTES = 64 * 1024
export const MAX_LANGUAGE_BYTES = 512 * 1024
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
export const MAX_MESSAGES = 16
export const MAX_CREATE_BYTES = 32 * 1024
export const MAX_RESPONSE_BYTES = MAX_LANGUAGE_BYTES + 64 * 1024
export const encoder = new TextEncoder()
export type Embed = Record<string, unknown>
export type ManifestEntry = { contentHash: string; byteLength: number }
export type SnapshotInput = {
  snapshotId: string; schemaVersion: 1; eventId: string; reportType: string
  reportDateTime: string | null; dateTime: string | null; serial: number
  infoType: string; infoTypePriority: number; isCancel: boolean; renderedAt: string
  contentHash: string; publisherEpoch: number; publisherSequence: number
  languages: Record<LanguageCode, ManifestEntry[]>
}

export class QuakeError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 413 | 415 | 503 = 400) { super(code) }
}
export function object(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))
    || required.some((key) => !Object.hasOwn(value, key))) throw new QuakeError('invalid_quakeinfo')
  return value as Record<string, unknown>
}
export function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new QuakeError('invalid_quakeinfo')
}
export function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new QuakeError('invalid_id')
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new QuakeError('invalid_hash')
}
export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
export function instant(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string') throw new QuakeError('invalid_time')
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString().slice(0, 19) !== match[1]) throw new QuakeError('invalid_time')
  return match[1] + '.' + (match[2] ?? '').padEnd(9, '0') + 'Z'
}
export async function snapshotInput(value: unknown): Promise<SnapshotInput> {
  const v = object(value, ['snapshotId','schemaVersion','eventId','reportType','reportDateTime','dateTime',
    'serial','infoType','infoTypePriority','isCancel','renderedAt','contentHash','publisherEpoch','publisherSequence','languages'])
  uuid(v.snapshotId)
  if (v.schemaVersion !== 1 || typeof v.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.eventId)
    || !['VXSE51','VXSE52','VXSE53','VXSE61'].includes(String(v.reportType))) throw new QuakeError('invalid_quakeinfo')
  integer(v.serial, -2147483648, 2147483647)
  if (!['発表','訂正','取消'].includes(String(v.infoType)) || typeof v.isCancel !== 'boolean'
    || v.isCancel !== (v.infoType === '取消')
    || v.infoTypePriority !== (v.isCancel ? 2 : v.infoType === '訂正' ? 1 : 0)) throw new QuakeError('invalid_quakeinfo')
  integer(v.publisherEpoch, 1)
  integer(v.publisherSequence, 1)
  hash(v.contentHash)
  const languages = object(v.languages, LANGUAGES.map((l) => l.code))
  let total = 0
  let manifest = ''
  for (const { code } of LANGUAGES) {
    const entries = languages[code]
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_MESSAGES) throw new QuakeError('invalid_manifest')
    let bytes = 0
    for (const [index, entry] of entries.entries()) {
      const e = object(entry, ['contentHash','byteLength'])
      hash(e.contentHash)
      integer(e.byteLength, 2, MAX_MESSAGE_BYTES)
      bytes += e.byteLength
      manifest += `${code}:${index}:${e.contentHash}:${e.byteLength}\n`
    }
    if (bytes > MAX_LANGUAGE_BYTES) throw new QuakeError('language_too_large', 413)
    total += bytes
  }
  if (total > MAX_SNAPSHOT_BYTES) throw new QuakeError('snapshot_too_large', 413)
  if (await sha256(manifest) !== v.contentHash) throw new QuakeError('invalid_hash')
  return { ...v, reportDateTime: instant(v.reportDateTime, true), dateTime: instant(v.dateTime, true),
    renderedAt: instant(v.renderedAt) } as SnapshotInput
}

/** Accept only sendable Discord Embed properties. URLs are inert display data, never fetched. */
export function validateEmbeds(value: unknown): asserts value is Embed[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new QuakeError('invalid_embeds')
  let count = 0
  function text(value: unknown, max: number) {
    if (typeof value !== 'string' || [...value].length > max) throw new QuakeError('invalid_embeds')
    count += [...value].length
  }
  function url(value: unknown) {
    if (typeof value !== 'string' || [...value].length > 2048) throw new QuakeError('invalid_embeds')
    try {
      const u = new URL(value)
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error()
    } catch { throw new QuakeError('invalid_embeds') }
  }
  for (const item of value) {
    const e = object(item, ['title','description','url','timestamp','color','type','fields','footer','image','thumbnail','author'], [])
    if (e.title !== undefined) text(e.title, 256)
    if (e.description !== undefined) text(e.description, 4096)
    if (e.url !== undefined) url(e.url)
    if (e.timestamp !== undefined) instant(e.timestamp)
    if (e.color !== undefined) integer(e.color, 0, 0xffffff)
    if (e.type !== undefined && e.type !== 'rich') throw new QuakeError('invalid_embeds')
    if (e.fields !== undefined) {
      if (!Array.isArray(e.fields) || e.fields.length > 25) throw new QuakeError('invalid_embeds')
      for (const item of e.fields) {
        const f = object(item, ['name','value','inline'], ['name','value'])
        text(f.name, 256); text(f.value, 1024)
        if (f.inline !== undefined && typeof f.inline !== 'boolean') throw new QuakeError('invalid_embeds')
      }
    }
    if (e.footer !== undefined) {
      const f = object(e.footer, ['text','icon_url'], ['text'])
      text(f.text, 2048)
      if (f.icon_url !== undefined) url(f.icon_url)
    }
    if (e.author !== undefined) {
      const a = object(e.author, ['name','url','icon_url'], ['name'])
      text(a.name, 256)
      if (a.url !== undefined) url(a.url)
      if (a.icon_url !== undefined) url(a.icon_url)
    }
    for (const key of ['image','thumbnail']) if (e[key] !== undefined) url(object(e[key], ['url']).url)
  }
  if (count > 6000) throw new QuakeError('invalid_embeds')
}

export async function readBody(request: Request, limit: number): Promise<string> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new QuakeError('unsupported_media_type', 415)
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new QuakeError('body_too_large', 413) }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    if (error instanceof QuakeError) throw error
    throw new QuakeError('invalid_body')
  } finally { reader?.releaseLock() }
}
export function parse(body: string): unknown {
  try { return JSON.parse(body) } catch { throw new QuakeError('invalid_json') }
}
export function language(value: unknown): LanguageCode {
  if (!isLanguageCode(value)) throw new QuakeError('invalid_language')
  return value
}
