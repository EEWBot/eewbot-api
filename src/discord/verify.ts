import { verifyKey } from 'discord-interactions'
import { MAX_SIGNATURE_AGE_SECONDS } from './constants'
import type { Interaction } from './types'

export type VerifiedRequest =
  | { ok: true; interaction: Interaction }
  | { ok: false; status: 400 | 401; error: 'invalid_signature' | 'invalid_json' | 'invalid_interaction' }

/**
 * Verifies the Ed25519 signature over the raw request bytes before any parsing,
 * and rejects stale timestamps to bound replay of captured requests.
 */
export async function verifyInteractionRequest(
  request: Request,
  publicKey: string,
  now = Date.now(),
): Promise<VerifiedRequest> {
  const signature = request.headers.get('X-Signature-Ed25519') ?? ''
  const timestamp = request.headers.get('X-Signature-Timestamp') ?? ''
  const issuedAt = Number(timestamp)
  if (
    !/^[0-9a-fA-F]{128}$/.test(signature) ||
    !/^\d{10,}$/.test(timestamp) ||
    !Number.isSafeInteger(issuedAt) ||
    Math.abs(now / 1000 - issuedAt) > MAX_SIGNATURE_AGE_SECONDS
  ) {
    return { ok: false, status: 401, error: 'invalid_signature' }
  }

  const rawBody = new Uint8Array(await request.arrayBuffer())
  if (!(await verifyKey(rawBody, signature, timestamp, publicKey))) {
    return { ok: false, status: 401, error: 'invalid_signature' }
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' }
  }
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof (payload as Interaction).type !== 'number'
  ) {
    return { ok: false, status: 400, error: 'invalid_interaction' }
  }
  return { ok: true, interaction: payload as Interaction }
}
