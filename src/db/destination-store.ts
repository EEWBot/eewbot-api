import type { LanguageCode } from '../i18n/languages'
import type {
  Destination,
  DestinationFlags,
  DestinationSnapshot,
  DestinationTarget,
  Intensity,
  Snowflake,
  WebhookCredential,
} from './destination-types'

export type VersionedDestination = { revision: number; destination: Destination | null }

export type LanguageSessionGuard = { id: string; actorId: Snowflake; revision: number; language: LanguageCode }

export type SettingsSessionGuard = { id: string; actorId: Snowflake }

export type DestinationChange =
  | { flags: Partial<DestinationFlags> }
  | { minIntensity: Intensity }
  | { webhook: WebhookCredential | null; lockOwner: string }
  | { remove: true }

export interface DestinationConfigSource {
  getRevision(): Promise<number>
  /** One SQL statement: revision and destinations always describe the same committed state. */
  loadSnapshot(): Promise<DestinationSnapshot>
}

/**
 * Every successful mutation that changes at least one row advances the revision
 * exactly once, in the same D1 transaction. Mutations return changed row counts.
 */
export interface DestinationStore extends DestinationConfigSource {
  getDestination(targetId: Snowflake): Promise<Destination | null>
  getVersionedDestination(targetId: Snowflake): Promise<VersionedDestination>
  insertDestinationIfAbsent(target: DestinationTarget): Promise<number>
  /** Single-statement compare-and-swap guarded by revision (and optionally a UI session). */
  changeIfRevision(
    target: DestinationTarget,
    revision: number,
    change: DestinationChange,
    session?: SettingsSessionGuard,
    now?: number,
  ): Promise<number>
  /** Language-only CAS guarded by a live language session. */
  changeLanguageFromSession(
    target: DestinationTarget,
    session: LanguageSessionGuard,
    language: LanguageCode,
    scope: 'target' | 'guild',
    now?: number,
  ): Promise<number>
  /** Advisory check, not a reservation. Includes parent channels and sibling threads. */
  isWebhookExclusiveToTarget(webhookId: Snowflake, targetId: Snowflake): Promise<boolean>
  isWebhookUnassigned(webhookId: Snowflake): Promise<boolean>
  removeByGuildId(guildId: Snowflake): Promise<number>
  removeDestinations(targetIds: readonly Snowflake[]): Promise<number>
  /** Clears only rows whose current webhook still matches, protecting replacements. */
  clearWebhooksByTargets(targets: readonly { targetId: Snowflake; expectedWebhookId: Snowflake }[]): Promise<number>
  clearWebhooksByIds(webhookIds: readonly Snowflake[]): Promise<number>
}
