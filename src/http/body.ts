import { ApiError } from './errors'

/** Parses a JSON request body. The caller is Core behind Cloudflare Access. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new ApiError('invalid_json')
  }
}
