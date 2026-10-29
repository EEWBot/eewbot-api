# QuakeInfo snapshot API (v1)

PR A supplies the storage/API contract. The Java publisher (PR B) and Discord
command (PR C) depend on it. No production migration or deployment is authorized.

Java Core owns JMA XML parsing, latest selection, correction/cancellation and
cross-report intensity supplementation, I18n, EmbedPacker and Renderer HMAC URLs.
Workers stores completed embeds and reads them without contacting Core.

## Authentication and methods

All endpoints below are relative to `/internal/v1/quakeinfo`. They reuse the
**existing shared Cloudflare Access Service Token**, `ACCESS_AUD` and trusted
`executionCtx.access`. No new token/AUD/JWT/Bearer mechanism is introduced.
Authentication precedes body parsing, routing and any D1 access. Existing clients
inside this common boundary can write; the allowed operations and data are narrow.
Java sends `EEWBOT_CF_ACCESS_CLIENT_ID` and `EEWBOT_CF_ACCESS_CLIENT_SECRET` as
`CF-Access-Client-Id` / `CF-Access-Client-Secret`. Never put these values in config,
D1, logs or PRs. All responses have `Cache-Control: no-store`.

| Method / path | Body / response |
| --- | --- |
| POST `/publisher/lease` | `{ "publisherId": "<random UUID v4 per boot>" }` → `{ "publisherEpoch": 1 }` |
| POST `/snapshots` | Snapshot metadata/manifest below → `{ "snapshotId": "…", "status": "accepted" }` |
| PUT `/snapshots/{id}/messages/{lang}/{index}` | Raw JSON **embed array**, for one Discord message → `{ "status": "accepted" }` |
| POST `/snapshots/{id}/commit` | `{}` → `{ "status": "committed", "snapshotId": "…", "revision": 1 }` |
| GET `/latest?lang=ja_jp` | `{ "revision": 1, "snapshot": <metadata>, "lang": "ja_jp", "messages": [{ "messageIndex": 0, "embeds": […] }] }` |
| GET `/latest/meta` | `{ "revision": 1, "snapshot": <metadata> }` |
| POST `/cleanup` | `{}` → `{ "status": "ok" }`; safe to retry |

Other Internal methods remain restricted. Unknown fields, languages, query
parameters, indices and non-JSON write requests are rejected. No callback URLs,
arbitrary HTTP requests or SQL are accepted. Embed display URLs are never fetched.

Snapshot creation body (all keys required; nullable dates explicitly use `null`):

```json
{
  "snapshotId": "11111111-1111-4111-8111-111111111111",
  "schemaVersion": 1,
  "eventId": "20260101000000",
  "reportType": "VXSE53",
  "reportDateTime": "2026-01-01T00:00:00Z",
  "dateTime": "2026-01-01T00:00:00Z",
  "serial": 1,
  "infoType": "発表",
  "infoTypePriority": 0,
  "isCancel": false,
  "renderedAt": "2026-01-01T00:00:01Z",
  "contentHash": "<SHA-256 manifest digest>",
  "publisherEpoch": 1,
  "publisherSequence": 1,
  "languages": {
    "ja_jp": [{ "contentHash": "<SHA-256 of raw PUT bytes>", "byteLength": 123 }],
    "en_us": [{ "contentHash": "…", "byteLength": 123 }],
    "zh_tw": [{ "contentHash": "…", "byteLength": 123 }],
    "ko_hanja": [{ "contentHash": "…", "byteLength": 123 }],
    "ko_kp": [{ "contentHash": "…", "byteLength": 123 }]
  }
}
```

The arrays declare contiguous zero-based message indices; their lengths can
differ. Compute lowercase SHA-256 over each **exact UTF-8 PUT body**, including
its whitespace. The overall `contentHash` is SHA-256 of UTF-8 concatenation of
`lang:index:contentHash:byteLength\n`, in the five-language order above, then
ascending index. It intentionally excludes renderedAt/boot/sequence so Core can
detect unchanged rendered content. Metadata also has a canonical request digest,
preventing conflicting reuse of an ID (JSON object key ordering is immaterial).
Serial is Java's signed 32-bit parsed integer; invalid/missing Java serials use -1.
Dates accept UTC ISO instants to nanosecond precision and normalize to nine digits.
Types are VXSE51/52/53/61. Priority is 0=発表, 1=訂正, 2=取消; cancellation and priority
must agree with infoType.

## Storage, atomicity and ordering

Migration `0005_quakeinfo_snapshots.sql` creates:

- `quake_snapshots`: metadata only, immutable source identity/order, content and
  request digests, publisher epoch/sequence, staging/committed status and timestamps.
- `quake_snapshot_manifest`: expected hash/UTF-8 size per language/message.
- `quake_snapshot_messages`: one embed array per language/message, composite PK.
- `quake_latest`: one pointer and **quake_revision**. `config_meta.channels_revision`
  is never touched by publication, read or cleanup.
- Publisher state/boot leases and bounded Discord interaction claims.

Five languages are **never stored in one row**; each language can occupy multiple
rows. Creation reserves metadata and manifest in a D1 batch transaction. Message
PUTs compare the manifest and are immutable. Exact retries succeed, mismatches
return 409. All five complete sets, indices, sizes and hashes must match before
commit can publish. Publication, retirement of the previous pointer and status
transition share one D1 batch transaction. Any failure rolls back all changes.

Publication compares `(reportDateTime, dateTime, numeric serial, priority)` exactly
like QuakeInfoStore, treating null dates as older. A lower tuple is always rejected.
A tied tuple may update only the **same source identity** (event/type/infoType),
using a greater `(publisherEpoch, publisherSequence)`. A different source tied on
all four fields is rejected, matching Core's first-accepted tie behavior. Every
new write/commit also requires the current issued epoch, fencing delayed older
processes even when their source is newer. A fenced publisher must stop; it must
not acquire another lease. Boot UUID lease retries are idempotent for seven days;
UUIDs must never be reused across boots. Publisher sequences are unique per epoch.

Repeated create/PUT/commit of identical data succeeds without another revision.
Historical committed snapshot recommits succeed without republishing it. 409
`incomplete_stale_or_fenced` means no publication occurred; Core reconciles meta.
Other conflicts include `publisher_fenced`, `snapshot_conflict`, `sequence_conflict`
and `message_conflict`. 400/413/415 are validation/size/media errors. 503 means
storage/capacity unavailable; retry with capped backoff. Exceptions/SQL are hidden.
After an ambiguous commit timeout, fetch latest/meta before retrying the same ID.

Reads use one primary-session SQL statement joining the selected committed pointer
and messages. Concurrent commits cannot mix snapshots. Empty state is
`snapshot: null, messages: []` (meta omits messages); latest data does not expire.
Metadata contains report information, renderedAt, createdAt and committedAt (epoch
milliseconds for the latter two).

## Migration numbering correction

The existing test-message migration remains `0004_discord_testmessage.sql`.
QuakeInfo is `0005_quakeinfo_snapshots.sql`; its SQL is unchanged from the initial
pre-release file named `0004_quakeinfo_snapshots.sql`. The staging database's
`d1_migrations` filename was corrected to 0005 after confirming the applied SQL
was identical. No database reset was needed: destinations, snapshots and both
revisions were preserved. Fresh databases apply 0001 through 0005 once; a repeat
reports no pending migrations. Node tests reject duplicate migration numbers.
## Limits and cleanup

Per message: 64 KiB actual UTF-8 JSON, 1–10 embeds, 25 fields/embed, 6000 combined
text code points/message and Discord property limits. Per language: 1–16 messages,
512 KiB. Per snapshot: 2 MiB. Creation body: 32 KiB. Responses: 576 KiB maximum.
Lease/commit/cleanup bodies: 1 KiB. Overflows fail without publishing partial data.
Database admission caps snapshots at 4096 and reserved body bytes at 256 MiB.
At capacity, creation fails closed (503); protected history is never evicted early.

Cleanup is opportunistic on lease/create and callable explicitly. Each transaction
removes at most 64 snapshots: incomplete staging older than one hour and committed
snapshots **retired** for at least 24 hours. Retirement time (not original commit
time) protects a very old snapshot just replaced by a newer one. The current
pointer is always protected. The read is a single statement; the 24-hour grace
also exceeds the Discord processing budget. Foreign-key cascades delete bodies
and manifests together. Cleanup is idempotent; failed transactions can be retried.
Boot leases retain seven days (current epoch protected, max 4096); interaction
claims expire after 20 minutes and are cleaned on incoming requests/publication.

## Verification / staging

Run `npm ci`, `npm run check`, `npm test`, `npm run build` and `npm run test:java`.
Unit tests use local D1 and synthetic native Access contexts; the HTTP integration
uses a test-only loopback bridge, never a deployed header-based bypass. No real
Access/Discord credentials or external requests are required by normal CI.
Apply migration with `npm run db:migrate:staging` before `npm run deploy:staging`.
Only staging Worker/D1/application may be changed. Fixture embeds must be clearly
marked TEST and sent only to the fixed test Guild, never ordinary destinations.
Record live verification separately; local tests do not prove real Access wiring.
