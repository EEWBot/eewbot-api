import { REQUEST_TIMEOUT_MS } from './constants'

/** A transport failure. Never carries the URL or upstream error, which may contain tokens. */
export class HttpFailure extends Error {
  override readonly name = 'HttpFailure'

  constructor(readonly kind: 'timeout' | 'connection') {
    super(kind)
  }
}

/** One HTTP attempt with a timeout. Redirects are not followed. */
export async function request(url: string, init: RequestInit): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    return { status: response.status, body: await response.text() }
  } catch (error) {
    throw new HttpFailure(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'connection')
  }
}
