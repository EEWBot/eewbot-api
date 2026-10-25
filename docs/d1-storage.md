# D1 destination storage

`src/db/` is an internal module, independent of Hono. No CRUD, debug dump or SQL
HTTP endpoint is exposed. `src/index.ts` and the existing Interaction tests are
unchanged. Creating the store requires an explicit D1 binding:

```ts
import { D1DestinationStore } from './db/d1-destination-store'

const store = new D1DestinationStore(env.DB)
const source = store // implements DestinationConfigSource
const snapshot = await source.loadSnapshot()
```

Destinations and snapshots contain webhook tokens. Do not log, serialize into public
responses, or attach them to exceptions. Store errors deliberately discard the
underlying D1 error/cause, which can contain bound values. Validation errors never
echo input URLs. Callers should handle `DestinationStorageError` with a generic
message and collect operation-level metrics without arguments or return values.

## Java reference and schema

The behavior follows EEWBot's `DestinationAdminRegistry`, `ChannelRegistrySql`,
`SqlAdminRegistry`, `ConfigRevisionStore`, `SqlDestinationConfigSource`,
`DeliverySnapshot`, `Channel`, `ChannelWebhook`, `ChannelFilter`,
`ChannelFilterSql`, SQLite/PostgreSQL Flyway V1/V2, and
`SqlDestinationStorageContract`/related edge-case integration tests. Reference
checkout: [EEWBot commit 8a94d8f](https://github.com/EEWBot/EEWBot/tree/8a94d8f36b1d6aeb7a4e74ed535f135e720a7fdf).
No Java source or existing Flyway migration is modified.

The initial D1 migration creates:

| Table | Columns and defaults |
| --- | --- |
| `destinations` | `target_id` TEXT primary key, `channel_id` required TEXT; nullable `thread_id`/`guild_id` TEXT; `eew_alert`, `eew_prediction`, `eew_decimation`, `quake_info`, `tsunami` INTEGER flags default 0; `min_intensity` INTEGER default 1; `lang` TEXT default `ja_jp`; nullable `webhook_url`/`webhook_id` TEXT |
| `config_meta` | Singleton `id = 1`, `channels_revision` INTEGER initially 0 |
| `data_migrations` | `name` TEXT primary key, `applied_at` UTC SQLite datetime text, `checksum` default empty string, nullable `meta` |

Indexes cover `channel_id`, `thread_id`, `guild_id`, `webhook_url` and `webhook_id`,
matching the existing SQL indexes. Webhook ID is deliberately **not unique**:
Java permits historical duplicates and checks exclusivity separately. The check
is advisory and does not reserve a webhook against concurrent assignment. A future
atomic assignment policy needs an explicit compatibility decision before adding
a unique constraint or conditional write.

Differences from Java SQLite/PostgreSQL:

- Every Snowflake uses TEXT, including the primary key and webhook ID. D1's
  JavaScript binding cannot safely round-trip 64-bit integer Snowflakes. Values
  remain canonical positive decimal strings from 1 through `2^64 - 1`. BigInt
  is used only for input range validation, never bound or JSON serialized.
- `tsunami` exists from the initial schema. There are no preexisting D1 rows to
  backfill from `quake_info` as Java V2 does. New rows keep both defaults false.
- TEXT primary keys explicitly disallow NULL, matching PostgreSQL primary key
  semantics and avoiding SQLite's nullable TEXT primary key behavior.
- Revision is a safe JavaScript integer; a SQL CHECK rejects increment past
  `Number.MAX_SAFE_INTEGER`, rolling back the mutation instead of rounding.
  This differs from Java's signed 64-bit counter.
- `data_migrations` uses the SQLite timestamp representation rather than
  PostgreSQL `TIMESTAMPTZ`. It is compatible application import history, not
  Flyway history or Wrangler's `d1_migrations`.
- Webhook input validation is stricter than Java's prefix/path check: canonical
  `https://discord.com/api/webhooks/{decimal_id}/{token}` only, no credentials,
  fragments, extra path segments or whitespace; any `thread_id` must be one valid
  Snowflake. Token characters are ASCII letters, digits, underscore and hyphen.
  Full accepted URLs and query parameters are stored unchanged.

## Operation contracts

All mutations return the affected row count. Reads return camelCase fields;
nullable columns are explicit `null`, never missing. `getDestination` returns
`null` for a missing target. Lists sort lexicographically by `targetId`, without
converting Snowflakes to numbers. Read results and snapshot containers are frozen.

| Operation | Contract |
| --- | --- |
| `insertDestinationIfAbsent` | Insert only; existing target is never overwritten. Missing/null language and intensity use Java's insert defaults. Missing flags are false; nullable fields default to null. |
| `removeDestination` | Delete exactly `target_id`, without cascading from a channel to its thread destinations. |
| `setFlags` | Allowlisted flag names only; multiple flags in one UPDATE. Empty flags are a no-op. |
| `setMinIntensity` | Java intensity code 0 through 9 (`UNKNOWN` through `SEVEN`). |
| `setLanguage`, `setLanguageByGuildId` | Non-null string; no additional language allowlist. |
| `setWebhook` | Validate URL and derive string ID together; explicit null clears both columns. Undefined is invalid. |
| `removeByGuildId` | Delete all matching channel/thread targets once per call. |
| `clearWebhookByUrls` | Deduplicate parsed webhook IDs; ignore invalid URLs without logging them. Different tokens/`thread_id` queries with the same ID match all rows using that ID. A bound JSON string with `json_each` avoids D1 parameter limits and keeps one mutation. |
| `getWebhookAbsentDestinations` | Return complete destinations whose URL is NULL, optionally AND-filtered with Java flag, guild/channel/thread, webhook and intensity semantics (`minIntensity <= intensity`). Undefined omits a predicate; explicit null on nullable ID filters means SQL NULL. |
| `isWebhookExclusiveToTarget` | True if no **other target** uses this webhook ID, across parent channels and all threads. True for an unused ID. |
| `getAllDestinations` | Complete destination records, with string IDs and explicit nulls. |
| `getRevision`, `loadSnapshot` | Source interface for future configuration readers. Snapshot includes all destination fields plus revision. |

The caller supplies the destination's target ID (channel ID for a channel, thread
ID for a thread). Parent channel ID remains in `channelId` for thread records.
The store never substitutes parent channel ID for target ID.

### Atomic revision updates

Each write uses exactly one D1 `batch()` containing adjacent statements:

1. The prepared INSERT/UPDATE/DELETE, with values bound separately.
2. `UPDATE config_meta SET channels_revision = channels_revision + 1
   WHERE id = 1 AND changes() > 0`.

D1 [documents batch statements as one SQL transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
The local D1 tests exercise `changes()` across statements, same-value updates,
zero-row writes, duplicate inserts, multi-row mutations, concurrent independent
store instances and rollback after the revision update. No SELECT/existence check
is used to decide a write or revision increment.

Successful inserts advance once. Duplicate inserts, zero matched rows and empty
batches do not advance. Same-value setters with a matched row advance once.
Bulk guild operations and webhook clearing advance once regardless of row count.
Any failed SQL statement rolls back the whole batch. All application destination
writes must go through this store; `config_meta`'s seeded singleton must be retained.

`loadSnapshot` uses **one SELECT** joining the singleton to all destinations. It
observes one SQLite state, including an empty destination list. Its revision cannot
get ahead of the included data, and a read after writes stop converges to the latest
state. No replication sessions or remote Java connections are introduced.

## Local tests and migration

```sh
npm ci
npm run check
npm test
npm run build
# Optional focused run (already included in npm test):
npm run test:d1

# Persistent development database; explicitly local and staging:
npx wrangler d1 migrations apply DB --env staging --local
# Repeating this is safe: Wrangler reports no pending migrations.
```

The [official Workers Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
runs tests on local workerd/D1 with `remoteBindings: false`, an isolated test-only
DB and the actual migration files. It does not load `.dev.vars`, real Discord
credentials, or Cloudflare auth. The original 11 Interaction tests run alongside
56 D1 cases covering the Java contract, 64-bit IDs, nulls/defaults, all setters,
filters, failure rollback, secret-free errors, concurrent revisions and snapshots.

Migrations are append-only after application. Use Wrangler's migration runner,
not raw re-execution of an already-applied SQL file. The initial CREATE statements
intentionally fail on incompatible existing objects instead of hiding schema drift
with `IF NOT EXISTS`. Repeated **runner** application preserves rows and revision.
Java Flyway version numbers are independent of D1 migration numbers.

## Staging setup and deployment

Only `env.staging` contains binding `DB`, database `eewbot-staging`, migrations
directory `migrations`. Production has no D1 binding. Worker names, domains,
public handlers and Discord Application settings remain unchanged.

Initial provisioning completed on 2026-10-25 in the eewbot.net account, APAC
region: database ID `30988518-b77a-4f66-806e-52f266a2aeda`.
`0001_initial_destination_schema.sql` was applied remotely with
`npm run db:migrate:staging`. No Worker was deployed and no production resource
was created or changed during provisioning.

In an authenticated environment with D1 permissions on the **eewbot.net** account:

```sh
npx wrangler whoami
npx wrangler d1 list --json
# Only if eewbot-staging does not already exist:
npx wrangler d1 create eewbot-staging
```

Use the actual UUID returned by Cloudflare as `env.staging.d1_databases[0].database_id`
in `wrangler.jsonc`. Never invent an ID. If multiple accounts are available, select
the eewbot.net account with `CLOUDFLARE_ACCOUNT_ID` before remote operations.
Missing D1 OAuth scopes require `npx wrangler login` or a suitably scoped API token.

```sh
# Both commands explicitly target staging remote D1:
npx wrangler d1 migrations list DB --env staging --remote
npm run db:migrate:staging
# Equivalent migration command after checking the real ID:
npx wrangler d1 migrations apply DB --env staging --remote
```

CLI flags were checked with Wrangler 4.152.0 `d1 migrations apply --help` and the
[official command reference](https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply).
The npm remote migration and deployment commands reject a missing database UUID.
Local tests, local migrations and both deployment dry runs work without remote auth.

The existing opt-in staging Actions workflow retains its master/environment gates:

```text
npm ci -> check -> test (Interactions + D1) -> build (both dry runs)
    -> staging remote D1 migration -> staging Worker deploy -> staging smoke test
```

The migration step must succeed before deployment. The smoke test checks health
and HTTP 401 for unsigned Interactions; authenticated PING/button responses are
covered locally with generated Ed25519 keys. The staging Actions token needs D1
edit permission as well as existing Worker deployment permissions. There is no
production migration/deployment workflow in this change.

## Next HTTP API change

Define authenticated, authorized internal versioned endpoints and a snapshot JSON
contract; map request validation to these store types and translate safe store
errors to HTTP responses. Decide which operations are available to which caller,
and add authorization/response-redaction tests before exposing any configuration.
Preserve Snowflakes as strings throughout transport. Decide separately whether
webhook assignment needs an atomic exclusivity policy. Discord production command
migration and Java remote D1 access remain separate work.
