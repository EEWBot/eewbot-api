import type {
  Destination,
  DestinationFilter,
  DestinationFlags,
  DestinationSnapshot,
  Intensity,
  NewDestination,
  Snowflake,
} from './destination-types'

export interface DestinationConfigSource {
  getRevision(): Promise<number>
  loadSnapshot(): Promise<DestinationSnapshot>
}

/** Internal API. Mutations return matched row counts, not revision deltas. */
export interface DestinationStore extends DestinationConfigSource {
  getDestination(targetId: Snowflake): Promise<Destination | null>
  destinationExists(targetId: Snowflake): Promise<boolean>
  getAllDestinations(): Promise<readonly Destination[]>
  getWebhookAbsentDestinations(filter?: DestinationFilter): Promise<readonly Destination[]>
  /** Advisory check, not a reservation. Includes parent channels and sibling threads. */
  isWebhookExclusiveToTarget(webhookId: Snowflake, targetId: Snowflake): Promise<boolean>
  insertDestinationIfAbsent(destination: NewDestination): Promise<number>
  removeDestination(targetId: Snowflake): Promise<number>
  setFlags(targetId: Snowflake, flags: Partial<DestinationFlags>): Promise<number>
  setMinIntensity(targetId: Snowflake, intensity: Intensity): Promise<number>
  setWebhook(targetId: Snowflake, url: string | null): Promise<number>
  setLanguage(targetId: Snowflake, lang: string): Promise<number>
  removeByGuildId(guildId: Snowflake): Promise<number>
  setLanguageByGuildId(guildId: Snowflake, lang: string): Promise<number>
  /** Invalid URLs are silently skipped, matching Java cleanup semantics. */
  clearWebhookByUrls(urls: readonly string[]): Promise<number>
}
