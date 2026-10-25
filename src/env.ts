import type { D1Database } from '@cloudflare/workers-types'

export type Bindings = {
  DISCORD_PUBLIC_KEY?: string
  DB?: D1Database
  /** Real staging Access application audience; unset means deny all internal requests. */
  ACCESS_AUD?: string
}
