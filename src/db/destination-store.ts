import type {
  Destination,
  DestinationFilter,
  DestinationFlags,
  DestinationSnapshot,
  Intensity,
  NewDestination,
  Snowflake,
} from './destination-types'
import type { LanguageCode } from '../i18n/languages'

export type LanguageSessionGuard = { id: string; actorId: Snowflake; revision: number; language: string }

export type DestinationChange =
  | { flags: Partial<DestinationFlags> }
  | { minIntensity: Intensity }
  | { webhookUrl: string | null; lockOwner: string }
  | { remove: true }

export type DestinationTarget = { targetId: Snowflake; guildId: Snowflake; channelId: Snowflake; threadId: Snowflake | null }

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
  /** Single-statement compare-and-swap, followed by revision++ in the same transaction. */
  changeIfRevision(target: DestinationTarget, revision: number, change: DestinationChange,
    session?: { id: string; actorId: Snowflake }): Promise<number>
  getVersionedDestination(targetId: Snowflake): Promise<{ revision: number; destination: Destination | null }>
  removeDestination(targetId: Snowflake): Promise<number>
  removeDestinations(targetIds: readonly Snowflake[]): Promise<number>
  clearWebhooksByTargets(targets: readonly { targetId: Snowflake, expectedWebhookId: Snowflake }[]): Promise<number>
  clearWebhooksByIds(webhookIds: readonly Snowflake[]): Promise<number>
  setFlags(targetId: Snowflake, flags: Partial<DestinationFlags>): Promise<number>
  setMinIntensity(targetId: Snowflake, intensity: Intensity): Promise<number>
  setWebhook(targetId: Snowflake, url: string | null): Promise<number>
  setLanguage(targetId: Snowflake, lang: string): Promise<number>
  /** Language-only CAS with a real language session and one revision transaction. */
  changeLanguageFromSession(target: DestinationTarget, session: LanguageSessionGuard, language: LanguageCode,
    scope: 'target' | 'guild'): Promise<number>
  removeByGuildId(guildId: Snowflake): Promise<number>
  setLanguageByGuildId(guildId: Snowflake, lang: string): Promise<number>
  /** Invalid URLs are silently skipped, matching Java cleanup semantics. */
  clearWebhookByUrls(urls: readonly string[]): Promise<number>
}
