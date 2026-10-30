import type { LanguageCode } from '../i18n/languages'

/** Canonical positive unsigned 64-bit decimal string. Never convert to Number. */
export type Snowflake = string

/** Java SeismicIntensity codes: UNKNOWN=0, ONE=1, ..., SEVEN=9. */
export type Intensity = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export type DestinationFlags = {
  readonly eewAlert: boolean
  readonly eewPrediction: boolean
  readonly eewDecimation: boolean
  readonly quakeInfo: boolean
  readonly tsunami: boolean
}

/** Sensitive: the token is a Discord credential. Never log it. */
export type WebhookCredential = {
  readonly id: Snowflake
  readonly token: string
}

/** Where a destination lives in Discord. `targetId` is the thread for threads, else the channel. */
export type DestinationTarget = {
  readonly targetId: Snowflake
  readonly guildId: Snowflake
  readonly channelId: Snowflake
  readonly threadId: Snowflake | null
}

export type Destination = DestinationFlags & {
  readonly targetId: Snowflake
  readonly channelId: Snowflake
  readonly threadId: Snowflake | null
  /** Nullable only for rows imported from the legacy Java store. */
  readonly guildId: Snowflake | null
  readonly minIntensity: Intensity
  readonly lang: LanguageCode
  readonly webhook: WebhookCredential | null
}

export type DestinationSnapshot = {
  readonly revision: number
  readonly destinations: readonly Destination[]
}
