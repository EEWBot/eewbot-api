/** Discord permission bits. https://discord.com/developers/docs/topics/permissions */
export const Permission = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_WEBHOOKS: 1n << 29n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const

/** Permissions requested by the invite link (unchanged from the Java bot). */
export const INVITE_PERMISSIONS = '275414830144'

/** Discord channel types the bot can deliver to. */
export const ChannelType = {
  GUILD_TEXT: 0,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
} as const

export const DELIVERABLE_CHANNEL_TYPES: readonly number[] = [ChannelType.GUILD_TEXT, ChannelType.GUILD_ANNOUNCEMENT]
export const THREAD_CHANNEL_TYPES: readonly number[] = [
  ChannelType.ANNOUNCEMENT_THREAD,
  ChannelType.PUBLIC_THREAD,
  ChannelType.PRIVATE_THREAD,
]

/** Embed accent color used by bot messages. */
export const EMBED_COLOR = 7506394

/** Signed interactions older than this are rejected as replays. */
export const MAX_SIGNATURE_AGE_SECONDS = 5 * 60
/** Each outgoing HTTP request. Deferred work must finish within waitUntil()'s 30 s. */
export const REQUEST_TIMEOUT_MS = 5_000
/** /help reads the channel language synchronously within Discord's 3 s deadline. */
export const INFO_DB_TIMEOUT_MS = 1_500
/** Minimum interval between /testmessage runs for one target. */
export const TESTMESSAGE_COOLDOWN_MS = 30_000
