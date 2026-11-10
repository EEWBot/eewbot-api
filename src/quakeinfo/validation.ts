import { TOO_LARGE } from '../http/body'
import { ApiError } from '../http/errors'
import { integer, object } from '../http/validate'
import { isLanguageCode, LANGUAGES, type LanguageCode } from '../i18n/languages'

export const MAX_MESSAGES = 16
const MAX_EMBEDS = 10
/**
 * UTF-8 bytes of one message's `embeds_json`: D1's documented 2,000,000-byte
 * row limit minus room for the key columns. A Discord-deliverable message is
 * far smaller; this only keeps an oversized one from reaching D1.
 */
export const MAX_MESSAGE_BYTES = 1_999_000
/**
 * Request body bytes of PUT /latest. The bound is the Worker's CPU budget, not
 * D1: parsing, validating and hashing cost roughly 4 ms per MB, and repeated
 * multi-MB publications were throttled (error 1102) on the 10 ms plan.
 * Core's QuakeInfoSnapshot caps the embeds JSON alone at 2 MiB; the extra 64 KiB
 * covers the envelope (metadata, language keys, separators) so such a report fits.
 */
export const MAX_REPORT_BYTES = 2 * 1024 * 1024 + 64 * 1024

/** `JSON.stringify(embeds)` computed during validation, so publishing does not serialize twice. */
const serialized = new WeakMap<Embed[], string>()

export function embedsJson(embeds: Embed[]): string {
  let json = serialized.get(embeds)
  if (json === undefined) {
    json = JSON.stringify(embeds)
    serialized.set(embeds, json)
  }
  return json
}

const INVALID = 'invalid_quakeinfo'
const REPORT_TYPES = ['VXSE51', 'VXSE52', 'VXSE53', 'VXSE61']
/** The index is the info type priority (announcement < correction < cancellation). */
const INFO_TYPES = ['発表', '訂正', '取消']

export type Embed = Record<string, unknown>

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export type QuakeReport = {
  eventId: string
  reportType: string
  reportDateTime: string | null
  dateTime: string | null
  serial: number
  infoType: string
  infoTypePriority: number
  /** Per language, 1..16 Discord messages of 1..10 embeds each. */
  languages: Record<LanguageCode, Embed[][]>
}

/** Normalizes a UTC ISO-8601 instant to nanosecond precision so values sort as text. */
export function instant(value: unknown): string | null {
  if (value === null) return null
  const match = typeof value === 'string' ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value) : null
  const seconds = match?.[1]
  if (!match || !seconds || new Date(`${seconds}Z`).toISOString().slice(0, 19) !== seconds) {
    throw new ApiError(INVALID)
  }
  return `${seconds}.${(match[2] ?? '').padEnd(9, '0')}Z`
}

export function language(value: unknown): LanguageCode {
  if (!isLanguageCode(value)) throw new ApiError('invalid_language')
  return value
}

/**
 * UTF-8 length without allocating the encoded bytes. Starts from one byte per
 * UTF-16 unit; a surrogate pair (2 units, 4 bytes) and any other unit from
 * U+0800 (3 bytes, U+FFFD for a lone surrogate) both add 2.
 */
export function utf8Length(value: string): number {
  let bytes = value.length
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x80) continue
    if (code < 0x800) {
      bytes += 1
      continue
    }
    bytes += 2
    const next = value.charCodeAt(i + 1)
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i++
  }
  return bytes
}

function messages(value: unknown): Embed[][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) throw new ApiError(INVALID)
  for (const embeds of value) {
    if (!Array.isArray(embeds) || embeds.length < 1 || embeds.length > MAX_EMBEDS) throw new ApiError(INVALID)
    // Core renders the embeds; Discord enforces their detailed limits on delivery.
    for (const embed of embeds) object(embed, INVALID)
    if (utf8Length(embedsJson(embeds)) > MAX_MESSAGE_BYTES) throw new ApiError(TOO_LARGE, 413)
  }
  return value
}

/** Validates a report published by Core. Unknown fields are ignored. */
export function quakeReport(value: unknown): QuakeReport {
  const v = object(value, INVALID)
  const infoTypePriority = INFO_TYPES.indexOf(String(v.infoType))
  if (
    typeof v.eventId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(v.eventId) ||
    typeof v.reportType !== 'string' ||
    !REPORT_TYPES.includes(v.reportType) ||
    infoTypePriority < 0
  ) {
    throw new ApiError(INVALID)
  }
  integer(v.serial, -2147483648, 2147483647, INVALID)
  const languages = object(v.languages, INVALID)
  return {
    eventId: v.eventId,
    reportType: v.reportType,
    reportDateTime: instant(v.reportDateTime),
    dateTime: instant(v.dateTime),
    serial: v.serial,
    infoType: String(v.infoType),
    infoTypePriority,
    languages: Object.fromEntries(LANGUAGES.map(({ code }) => [code, messages(languages[code])])) as Record<
      LanguageCode,
      Embed[][]
    >,
  }
}
