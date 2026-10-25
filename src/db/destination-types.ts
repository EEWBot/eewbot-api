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

export type Destination = DestinationFlags & {
  readonly targetId: Snowflake
  readonly channelId: Snowflake
  readonly threadId: Snowflake | null
  readonly guildId: Snowflake | null
  readonly minIntensity: Intensity
  readonly lang: string
  /** Sensitive: contains a Discord token. Do not log destinations/snapshots. */
  readonly webhookUrl: string | null
  readonly webhookId: Snowflake | null
}

/** Missing/null language or intensity uses the Java insert defaults. */
export type NewDestination = Partial<DestinationFlags> & {
  readonly targetId: Snowflake
  readonly channelId: Snowflake
  readonly threadId?: Snowflake | null
  readonly guildId?: Snowflake | null
  readonly minIntensity?: Intensity | null
  readonly lang?: string | null
  readonly webhookUrl?: string | null
}

/** undefined omits a predicate; explicit null selects SQL NULL for nullable IDs. */
export type DestinationFilter = Partial<DestinationFlags> & {
  readonly hasGuild?: boolean | null
  readonly guildId?: Snowflake | null
  readonly channelId?: Snowflake
  readonly threadId?: Snowflake | null
  readonly isThread?: boolean | null
  /** Matches destinations whose minIntensity <= this code, as in ChannelFilter. */
  readonly intensity?: Intensity
  readonly webhookId?: Snowflake | null
}

export type DestinationSnapshot = {
  readonly revision: number
  readonly destinations: readonly Destination[]
}
