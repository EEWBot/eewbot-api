/**
 * Structured logging for Workers Logs. Emit one JSON object per line.
 *
 * Never pass tokens, webhook URLs, request bodies, SQL or caught error objects:
 * D1 and fetch errors can embed bound credentials. Log identifiers and codes only.
 */
type Fields = Record<string, string | number | boolean | null | undefined>

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Fields): void {
  const line = JSON.stringify({ level, event, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const log = {
  info: (event: string, fields: Fields = {}) => emit('info', event, fields),
  warn: (event: string, fields: Fields = {}) => emit('warn', event, fields),
  error: (event: string, fields: Fields = {}) => emit('error', event, fields),
}

/** A constructor name is safe to log; messages and causes are not. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
