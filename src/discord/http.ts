import { REQUEST_TIMEOUT_MS } from './constants'

/** Bounded, single-attempt HTTP. Never retain upstream bodies in exceptions. */
export class HttpFailure extends Error {
  override readonly name = 'HttpFailure'

  constructor(readonly kind: 'timeout' | 'connection' | 'oversized') {
    super(kind)
  }
}

export const MAX_RESPONSE_BYTES = 64 * 1024

export async function boundedRequest(
  url: string,
  init: RequestInit,
  deadline: number,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController()
  const remaining = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())
  if (remaining <= 0) throw new HttpFailure('timeout')
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = async () => {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal })
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {})
      throw new HttpFailure('timeout')
    }
    const length = response.headers.get('content-length')
    if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {})
      throw new HttpFailure('oversized')
    }
    reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new HttpFailure('oversized')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { status: response.status, body: new TextDecoder().decode(bytes) }
  }
  try {
    // Race the entire operation, including body reads and transports ignoring abort.
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new HttpFailure('timeout'))
        }, remaining)
      }),
    ])
  } catch (error) {
    const timedOut = controller.signal.aborted
    controller.abort()
    void reader?.cancel().catch(() => {})
    if (error instanceof HttpFailure) throw error
    throw new HttpFailure(timedOut ? 'timeout' : 'connection')
  } finally {
    clearTimeout(timer)
  }
}
