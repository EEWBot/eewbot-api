# D1 storage

The schema is `migrations/0001_schema.sql` (squashed on 2026-10-31) plus
`0002_simplify.sql`, which removed the interaction receipt, session, lock and
multi-snapshot tables.
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
| `destinations` | Delivery configuration. `target_id` is the thread ID for threads, else the channel ID (enforced by CHECKs). `lang` is one of the five supported codes; `min_intensity` is 0–9. `webhook_id`/`webhook_token` are both NULL or both set; every target, including each thread, has its own webhook. `guild_id` is nullable only for future imports of legacy Java rows. |
| `config_meta` | Singleton (`id = 1`) `channels_revision`, capped at 2^53−1 by a CHECK. |
| `testmessage_cooldowns` | `/testmessage` cooldown, one row per target. |
| `quake_latest` | Singleton latest earthquake report published by Core, with its own `revision`. |
| `quake_messages` | Embeds of the latest report per language and message index. |

## Revision contract

Every destination write in `D1DestinationStore` is one D1 `batch()` (a
transaction) of two adjacent statements:

1. The INSERT/UPDATE/DELETE with bound values.
2. `UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1 AND changes() > 0`.

So a write that changes rows advances the revision exactly once (bulk writes
included), a no-op does not, and any failure rolls back both. `loadSnapshot()` is
a single SELECT joining `config_meta` to `destinations`, so its revision always
matches its rows. Core polls the revision to reload its configuration.

Writes from Discord match the full target identity (target, guild, channel and
thread). They are not compare-and-swap: concurrent menu edits are last write
wins. Cleanup ID lists are bound as one JSON array via `json_each`, avoiding
D1's parameter limit while staying a single statement.

## Earthquake report

`QuakeStore.publish()` is one batch: an upsert of `quake_latest` that only
applies when the new report is not older (Java ordering key), message inserts
that only apply under the new `snapshot_id`, and a delete of every other
report's messages. A rejected (older) report therefore changes nothing, and
readers never see a mix of two reports. No other cleanup is needed.

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
