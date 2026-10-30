import { ApiError } from '../http/errors'
import { integer, object } from '../http/validate'
import { isLanguageCode, LANGUAGES, type LanguageCode } from '../i18n/languages'

export const MAX_MESSAGES = 16
const MAX_EMBEDS = 10

const INVALID = 'invalid_quakeinfo'
const REPORT_TYPES = ['VXSE51', 'VXSE52', 'VXSE53', 'VXSE61']
/** The index is the info type priority (announcement < correction < cancellation). */
const INFO_TYPES = ['発表', '訂正', '取消']

export type Embed = Record<string, unknown>
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

function messages(value: unknown): Embed[][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) throw new ApiError(INVALID)
  for (const embeds of value) {
    if (!Array.isArray(embeds) || embeds.length < 1 || embeds.length > MAX_EMBEDS) throw new ApiError(INVALID)
    // Core renders the embeds; Discord enforces their detailed limits on delivery.
    for (const embed of embeds) object(embed, INVALID)
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
