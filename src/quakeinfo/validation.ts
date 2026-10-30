import { ApiError } from '../http/errors'
import { integer, strictObject, uuid } from '../http/validate'
import { isLanguageCode, LANGUAGES, type LanguageCode } from '../i18n/languages'

export const MAX_MESSAGE_BYTES = 64 * 1024
export const MAX_LANGUAGE_BYTES = 512 * 1024
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
export const MAX_MESSAGES = 16
export const MAX_CREATE_BYTES = 32 * 1024
export const MAX_RESPONSE_BYTES = MAX_LANGUAGE_BYTES + 64 * 1024
export const MAX_CONTROL_BYTES = 1024

const INVALID = 'invalid_quakeinfo'
const INVALID_EMBEDS = 'invalid_embeds'
const REPORT_TYPES = ['VXSE51', 'VXSE52', 'VXSE53', 'VXSE61']
/** The index is the info type priority (announcement < correction < cancellation). */
const INFO_TYPES = ['発表', '訂正', '取消']

export const encoder = new TextEncoder()

export type Embed = Record<string, unknown>
export type ManifestEntry = { contentHash: string; byteLength: number }
export type SnapshotInput = {
  snapshotId: string
  schemaVersion: 1
  eventId: string
  reportType: string
  reportDateTime: string | null
  dateTime: string | null
  serial: number
  infoType: string
  infoTypePriority: number
  isCancel: boolean
  renderedAt: string
  contentHash: string
  publisherEpoch: number
  publisherSequence: number
  languages: Record<LanguageCode, ManifestEntry[]>
}

function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new ApiError('invalid_hash')
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Key-sorted JSON, used to detect a non-identical replay of the same snapshot ID. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/** Normalizes a UTC ISO-8601 instant to nanosecond precision so values sort as text. */
export function instant(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string') throw new ApiError('invalid_time')
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value)
  const seconds = match?.[1]
  if (
    !match ||
    !seconds ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString().slice(0, 19) !== seconds
  ) {
    throw new ApiError('invalid_time')
  }
  return `${seconds}.${(match[2] ?? '').padEnd(9, '0')}Z`
}

export function language(value: unknown): LanguageCode {
  if (!isLanguageCode(value)) throw new ApiError('invalid_language')
  return value
}

const SNAPSHOT_KEYS = [
  'snapshotId',
  'schemaVersion',
  'eventId',
  'reportType',
  'reportDateTime',
  'dateTime',
  'serial',
  'infoType',
  'infoTypePriority',
  'isCancel',
  'renderedAt',
  'contentHash',
  'publisherEpoch',
  'publisherSequence',
  'languages',
]

export async function snapshotInput(value: unknown): Promise<SnapshotInput> {
  const v = strictObject(value, SNAPSHOT_KEYS, { code: INVALID })
  uuid(v.snapshotId)
  if (
    v.schemaVersion !== 1 ||
    typeof v.eventId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(v.eventId) ||
    !REPORT_TYPES.includes(String(v.reportType))
  ) {
    throw new ApiError(INVALID)
  }
  integer(v.serial, -2147483648, 2147483647, INVALID)
  const priority = INFO_TYPES.indexOf(String(v.infoType))
  if (priority < 0 || v.isCancel !== (priority === 2) || v.infoTypePriority !== priority) throw new ApiError(INVALID)
  integer(v.publisherEpoch, 1, undefined, INVALID)
  integer(v.publisherSequence, 1, undefined, INVALID)
  hash(v.contentHash)

  const languages = strictObject(
    v.languages,
    LANGUAGES.map((l) => l.code),
    { code: INVALID },
  )
  let total = 0
  let manifest = ''
  for (const { code } of LANGUAGES) {
    const entries = languages[code]
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_MESSAGES) {
      throw new ApiError('invalid_manifest')
    }
    let bytes = 0
    for (const [index, entry] of entries.entries()) {
      const e = strictObject(entry, ['contentHash', 'byteLength'], { code: INVALID })
      hash(e.contentHash)
      integer(e.byteLength, 2, MAX_MESSAGE_BYTES, INVALID)
      bytes += e.byteLength
      manifest += `${code}:${index}:${e.contentHash}:${e.byteLength}\n`
    }
    if (bytes > MAX_LANGUAGE_BYTES) throw new ApiError('language_too_large', 413)
    total += bytes
  }
  if (total > MAX_SNAPSHOT_BYTES) throw new ApiError('snapshot_too_large', 413)
  if ((await sha256(manifest)) !== v.contentHash) throw new ApiError('invalid_hash')
  return {
    ...v,
    reportDateTime: instant(v.reportDateTime, true),
    dateTime: instant(v.dateTime, true),
    renderedAt: instant(v.renderedAt),
  } as SnapshotInput
}

const EMBED_KEYS = [
  'title',
  'description',
  'url',
  'timestamp',
  'color',
  'type',
  'fields',
  'footer',
  'image',
  'thumbnail',
  'author',
]

/** Accept only sendable Discord Embed properties. URLs are inert display data, never fetched. */
export function validateEmbeds(value: unknown): asserts value is Embed[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new ApiError(INVALID_EMBEDS)
  let characters = 0
  const object = (item: unknown, keys: readonly string[], required: readonly string[] = []) =>
    strictObject(item, keys, { required, code: INVALID_EMBEDS })
  const text = (item: unknown, max: number) => {
    if (typeof item !== 'string' || [...item].length > max) throw new ApiError(INVALID_EMBEDS)
    characters += [...item].length
  }
  const url = (item: unknown) => {
    if (typeof item !== 'string' || [...item].length > 2048) throw new ApiError(INVALID_EMBEDS)
    try {
      const u = new URL(item)
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error()
    } catch {
      throw new ApiError(INVALID_EMBEDS)
    }
  }
  for (const item of value) {
    const e = object(item, EMBED_KEYS)
    if (e.title !== undefined) text(e.title, 256)
    if (e.description !== undefined) text(e.description, 4096)
    if (e.url !== undefined) url(e.url)
    if (e.timestamp !== undefined) instant(e.timestamp)
    if (e.color !== undefined) integer(e.color, 0, 0xffffff, INVALID_EMBEDS)
    if (e.type !== undefined && e.type !== 'rich') throw new ApiError(INVALID_EMBEDS)
    if (e.fields !== undefined) {
      if (!Array.isArray(e.fields) || e.fields.length > 25) throw new ApiError(INVALID_EMBEDS)
      for (const item of e.fields) {
        const f = object(item, ['name', 'value', 'inline'], ['name', 'value'])
        text(f.name, 256)
        text(f.value, 1024)
        if (f.inline !== undefined && typeof f.inline !== 'boolean') throw new ApiError(INVALID_EMBEDS)
      }
    }
    if (e.footer !== undefined) {
      const f = object(e.footer, ['text', 'icon_url'], ['text'])
      text(f.text, 2048)
      if (f.icon_url !== undefined) url(f.icon_url)
    }
    if (e.author !== undefined) {
      const a = object(e.author, ['name', 'url', 'icon_url'], ['name'])
      text(a.name, 256)
      if (a.url !== undefined) url(a.url)
      if (a.icon_url !== undefined) url(a.icon_url)
    }
    for (const key of ['image', 'thumbnail']) {
      if (e[key] !== undefined) url(object(e[key], ['url'], ['url']).url)
    }
  }
  if (characters > 6000) throw new ApiError(INVALID_EMBEDS)
}
