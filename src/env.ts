import type { D1Database } from '@cloudflare/workers-types'

export type Bindings = {
  DISCORD_PUBLIC_KEY?: string
  DISCORD_APPLICATION_ID?: string
  DISCORD_COMMANDS_ENABLED?: string
  /** Environment-specific bot credential; never use the Access Service Token for Discord. */
  DISCORD_BOT_TOKEN?: string
  /** Private Sender origin: Worker Secret, never a public Wrangler var or log value. */
  WEBHOOK_SENDER_URL?: string
  WEBHOOK_SENDER_ACCESS_CLIENT_ID?: string
  WEBHOOK_SENDER_ACCESS_CLIENT_SECRET?: string
  WEBHOOK_SENDER_AUTH_TOKEN?: string
  DB?: D1Database
  /** Real staging Access application audience; unset means deny all internal requests. */
  ACCESS_AUD?: string
}
