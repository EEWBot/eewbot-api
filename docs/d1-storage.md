# D1 storage

The whole schema is `migrations/0001_schema.sql` (squashed on 2026-10-31; earlier
staging migrations were discarded together with the staging database).
Wrangler records applied migrations in `d1_migrations`. Migrations are
append-only once applied to a remote database: add `0002_*.sql` for later changes.

## Conventions

- Snowflakes are canonical decimal **TEXT** (1 … 2^64−1). D1's JavaScript binding
  cannot round-trip 64-bit integers, so they are never bound as numbers.
- Every timestamp is Unix epoch **milliseconds**, bound from the Worker
  (`Date.now()`), never `unixepoch()`. This keeps one unit everywhere and lets
  tests inject time.
- Booleans are `INTEGER` with `CHECK (x IN (0, 1))`.
- Destinations and snapshots contain webhook tokens. Never log them, return them
  from public routes or attach them to errors. Store failures surface as
  `StorageError` without the original D1 error, which can contain bound values.

## Tables

| Table | Purpose |
| --- | --- |
| `destinations` | Delivery configuration. `target_id` is the thread ID for threads, else the channel ID (enforced by CHECKs). `lang` is one of the five supported codes; `min_intensity` is 0–9. `webhook_id`/`webhook_token` are both NULL or both set; the execute URL is built in code. `guild_id` is nullable only for future imports of legacy Java rows. |
| `config_meta` | Singleton (`id = 1`) `channels_revision`, capped at 2^53−1 by a CHECK. |
| `interaction_receipts` | One row per claimed Discord interaction ID, so redeliveries never repeat side effects. Shared by every deferred command. |
| `discord_sessions` | Short-lived component sessions for `/setup`, `/unregister` and `/lang` menus (`kind`). `language` is required exactly for `lang` sessions. |
| `discord_setup_locks` | Per-channel lease serializing webhook discovery/creation across a channel and its threads. |
| `discord_testmessage_runs` | `/testmessage` rate-limit ledger (per target, actor and guild window). |
| `quake_*` | Earthquake snapshot publication; see [quakeinfo snapshot API](quakeinfo-snapshot-api.md). |

`destinations.webhook_id` is deliberately **not unique** in the schema; assignment
exclusivity is enforced atomically by the guarded UPDATE described below.

## Revision contract

Every destination write in `D1DestinationStore` is one D1 `batch()` (a
transaction) of two adjacent statements:

1. The INSERT/UPDATE/DELETE with bound values.
2. `UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1 AND changes() > 0`.

So a write that changes rows advances the revision exactly once (bulk writes
included), a no-op does not, and any failure rolls back both. `loadSnapshot()` is
a single SELECT joining `config_meta` to `destinations`, so its revision always
matches its rows.

## Store operations (`src/db/destination-store.ts`)

| Operation | Contract |
| --- | --- |
| `getRevision`, `loadSnapshot` | `DestinationConfigSource` used by the internal API. |
| `getDestination`, `getVersionedDestination` | Read one target, the latter together with the current revision. |
| `insertDestinationIfAbsent(target)` | Insert with column defaults; never overwrites. |
| `changeIfRevision(target, revision, change, session?)` | Compare-and-swap on the full target identity and the revision. `change` is flags, minimum intensity, webhook assignment or removal. A webhook assignment additionally requires that no other target holds the webhook and that the caller holds the live channel setup lock. With `session`, a live `discord_sessions` row of the matching kind, actor and revision must exist. |
| `changeLanguageFromSession(target, session, language, scope)` | Language CAS guarded by a live `lang` session whose source row still has the session language; `scope` is the target or the whole guild (guild scope applies the session language). |
| `isWebhookExclusiveToTarget`, `isWebhookUnassigned` | Advisory reads used before assignment and orphan cleanup. |
| `removeByGuildId`, `removeDestinations`, `clearWebhooksByTargets`, `clearWebhooksByIds` | Cleanup API mutations. ID lists are bound as one JSON array via `json_each`, avoiding D1's parameter limit while staying a single statement. |

## Expiry

Request paths only read rows that are still live (`expires_at > now`), so expiry
is enforced without deleting anything. The cron trigger (`*/10 * * * *`) runs
`purgeExpired()` in `src/maintenance.ts`, which deletes expired receipts,
sessions, locks and testmessage runs, and runs the bounded quake snapshot
retention sweep.

## Operations

```sh
npm run db:migrate:local                 # local development database
npm run db:migrate:staging               # remote staging (checks database_id first)
npm run db:migrate:production            # remote production (checks database_id first)
npx wrangler d1 migrations list DB --env staging --remote
```

`scripts/check-d1.mjs <env>` refuses remote migration/deployment unless the
environment's `DB` binding names the expected database and a real UUID.

### Staging database history

The squashed `0001_schema.sql` is incompatible with databases created by the old
migrations. On 2026-10-31 staging (test data only) moved to a new database,
`eewbot-staging-v2` (APAC, `09204878-a393-4256-8aee-276136066a75`), and the old
`eewbot-staging` database was deleted. To recreate it again:

```sh
npx wrangler d1 create <name>
# put the UUID and name into env.staging in wrangler.jsonc
#   and EXPECTED_DATABASES in scripts/check-d1.mjs
npm run db:migrate:staging
npm run deploy:staging
```
