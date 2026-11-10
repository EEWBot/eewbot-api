import { ApiError } from './errors'

/** Also listed in Core's quakeinfo client SAFE_CODES, so Core reports it verbatim. */
export const TOO_LARGE = 'body_too_large'

/** Decodes the body as UTF-8 (like Request.json()), failing as soon as it exceeds `maxBytes`. */
async function readText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw new ApiError(TOO_LARGE, 413)
  if (!request.body) return ''
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ApiError(TOO_LARGE, 413)
    }
    parts.push(decoder.decode(value, { stream: true }))
  }
  parts.push(decoder.decode())
  return parts.join('')
}

/**
 * Parses a JSON request body. The caller is Core behind Cloudflare Access.
 * With `maxBytes`, a larger body is rejected with 413 before it is buffered.
 */
export async function readJson(request: Request, maxBytes?: number): Promise<unknown> {
  let text: string
  try {
    text = maxBytes === undefined ? await request.text() : await readText(request, maxBytes)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('invalid_json')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('invalid_json')
  }
}
