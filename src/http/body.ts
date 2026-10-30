import { ApiError } from './errors'

function isJsonContentType(request: Request): boolean {
  return request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

/**
 * Reads an application/json body as strict UTF-8 text. Counts actually streamed
 * bytes, so a missing or misleading Content-Length cannot bypass the limit.
 */
export async function readJsonText(request: Request, limit: number): Promise<string> {
  if (!isJsonContentType(request)) throw new ApiError('unsupported_media_type', 415)
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new ApiError('body_too_large', 413)
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('invalid_body')
  } finally {
    reader?.releaseLock()
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('invalid_json')
  }
}

export async function readJson(request: Request, limit: number): Promise<unknown> {
  return parseJson(await readJsonText(request, limit))
}
