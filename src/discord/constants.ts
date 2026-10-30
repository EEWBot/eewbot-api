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
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const

export const DELIVERABLE_CHANNEL_TYPES: readonly number[] = [ChannelType.GUILD_TEXT, ChannelType.GUILD_ANNOUNCEMENT]
export const THREAD_CHANNEL_TYPES: readonly number[] = [
  ChannelType.ANNOUNCEMENT_THREAD,
  ChannelType.PUBLIC_THREAD,
  ChannelType.PRIVATE_THREAD,
]
export const THREAD_PARENT_CHANNEL_TYPES: readonly number[] = [
  ...DELIVERABLE_CHANNEL_TYPES,
  ChannelType.GUILD_FORUM,
  ChannelType.GUILD_MEDIA,
]

/** `context` value of an interaction run inside a guild. */
export const GUILD_CONTEXT = 0
/** `authorizing_integration_owners` keys. */
export const GUILD_INSTALL = '0'
export const USER_INSTALL = '1'

/** Embed accent color used by bot messages. */
export const EMBED_COLOR = 7506394

// Time budgets. Discord's interaction token is valid for 15 minutes, but the
// background work must also fit within the Worker's waitUntil() lifetime.

/** Signed interactions older than this are rejected as replays. */
export const MAX_SIGNATURE_AGE_SECONDS = 5 * 60
/** Each Discord REST/HTTP attempt. */
export const REQUEST_TIMEOUT_MS = 2_500
/** Default deadline for all REST calls of one deferred command. */
export const REST_DEADLINE_MS = 20_000
/** Storage-mutating steps must start before this much time has elapsed. */
export const OPERATION_BUDGET_MS = 18_000
/** /quakeinfo sends several follow-up messages and gets a longer deadline. */
export const QUAKEINFO_DEADLINE_MS = 25_000
/** Fresh budget to report a failure after the main deadline was consumed. */
export const ERROR_REPLY_BUDGET_MS = 5_000
/** /help reads the channel language synchronously within Discord's 3 s deadline. */
export const INFO_DB_TIMEOUT_MS = 1_500

/** Interaction receipts outlive Discord's redelivery window. */
export const RECEIPT_TTL_MS = 20 * 60_000
/** Component sessions (menus/buttons) stay usable for this long. */
export const SESSION_TTL_MS = 10 * 60_000
/** Longer than the complete bounded background operation, including cleanup. */
export const SETUP_LOCK_TTL_MS = 120_000
