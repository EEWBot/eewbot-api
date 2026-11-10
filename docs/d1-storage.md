# D1 storage

The schema is `migrations/0001_schema.sql`, consolidated before production
rollout. It creates only the current tables. Wrangler records applied migrations
in `d1_migrations`. After rollout, keep applied migrations immutable and append
a new migration with the next unused number for each schema change.
Databases with the earlier 0001/0002 history must be recreated before applying
this consolidated baseline; do not apply it over the old schema.

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
| `destinations` | Delivery configuration. `target_id` is the thread ID for threads, else the channel ID (enforced by CHECKs). `lang` is validated by the Worker (`isLanguageCode`), without a database language list; `min_intensity` is 0–9. `webhook_id`/`webhook_token` are both NULL or both set; guild targets, including threads, have their own webhook when permitted. `guild_id` is NULL for DMs and imported legacy rows without a known guild; DM destinations use bot messages. |
| `config_meta` | Singleton (`id = 1`) `channels_revision`, capped at 2^53−1 by a CHECK. |
| `testmessage_cooldowns` | `/testmessage` cooldown, one row per target. |
| `quake_latest` | Singleton latest earthquake report published by Core, with its own `revision`. |
| `quake_messages` | Embeds of the latest report per language and non-negative message index, without a database language list or index upper limit. |

Destination `created_at` and `updated_at` are required Unix millisecond timestamps.
Registration and import set both on insert; updates preserve `created_at` and set
`updated_at` only when delivery values differ. Repeating an identical update, guild
language apply, import or registration leaves both timestamps and the revision unchanged.
Import timestamps record when the row entered D1, not its original registration
in Core. They help correlate rows with import runs and Discord activity; they do
not independently identify the source of a row. These fields remain internal to D1
and are not added to the Core configuration snapshot.

## Revision contract

Every destination write in `D1DestinationStore` is one D1 `batch()` (a
transaction) of two adjacent statements:

1. The INSERT/UPDATE/DELETE with bound values.
2. `UPDATE config_meta SET channels_revision = channels_revision + 1 WHERE id = 1 AND changes() > 0`.

UPDATE statements exclude identical values with null-safe `IS NOT` predicates;
SQLite `changes()` alone counts matched rows, including identical assignments.
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

The messages of one language are a single `INSERT … SELECT … FROM (VALUES …)`
with each `embeds_json` as its own bound parameter (at most 2 + 2 × 16 = 34, under
D1's 100), so a publication is always 8 statements, whatever the message count.
Bound values do not count toward D1's 100 KB statement length, and each message
is capped below the 2,000,000-byte row limit by validation (measured on D1: rows
up to 8 MB are stored, 10 MB fail with `SQLITE_TOOBIG`; the documented limit is
used). D1 is not the binding limit for the request size: parsing, validating and
hashing cost roughly 4 ms of CPU per MB (more for object-dense JSON), and repeated
multi-MB publications were throttled with error 1102 on the 10 ms CPU plan, so
`PUT /quakeinfo/latest` caps the body at 2 MiB + 64 KiB (Core's 2 MiB of embeds plus
the envelope). Raise `MAX_REPORT_BYTES` only with a larger CPU budget.

## Operations

```sh
npm run db:migrate:local                 # local development database
npm run db:migrate:staging               # remote staging (checks database_id first)
npm run db:migrate:production            # remote production (checks database_id first)
npx wrangler d1 migrations list DB --env staging --remote
```

`scripts/check-d1.mjs <env>` refuses remote migration/deployment unless the
environment's `DB` binding names the expected database and a real UUID.

### Recreating staging

Staging contains only test data. Use the stable name `eewbot-staging`, without a
version suffix. Delete only the staging database being replaced, create its
replacement, update `env.staging.d1_databases` in `wrangler.jsonc`, then migrate
and redeploy so the Worker uses the new binding:

```sh
npx wrangler d1 delete <old-staging-name>
npx wrangler d1 create eewbot-staging --location apac
# put the new UUID into env.staging in wrangler.jsonc
npm run db:migrate:staging
npm run deploy:staging
```

For a local database with the earlier migration history, use a fresh Wrangler
persist directory (or discard its test data) before applying this baseline.
