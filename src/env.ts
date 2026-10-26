import type { D1Database } from '@cloudflare/workers-types'

export type Bindings = {
  DISCORD_PUBLIC_KEY?: string
  DISCORD_APPLICATION_ID?: string
  DISCORD_TEST_GUILD_ID?: string
  DISCORD_COMMANDS_ENABLED?: string
  /** Staging bot credential; never use the Access Service Token for Discord. */
  DISCORD_BOT_TOKEN?: string
  DB?: D1Database
  /** Real staging Access application audience; unset means deny all internal requests. */
  ACCESS_AUD?: string
}
