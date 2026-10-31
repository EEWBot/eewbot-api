# Internal API v2

Base path: `/internal/v2`. The only client is EEWBot Java Core, a single
instance. It reads the delivery configuration, reports stale destinations and
webhooks, and publishes the latest earthquake report.

## Authentication

The whole `/internal` subtree is protected by one Cloudflare Access application
whose Service Auth policy admits only the Core Service Token. Core sends
`CF-Access-Client-Id` and `CF-Access-Client-Secret`, from the environment
variables `EEWBOT_CF_ACCESS_CLIENT_ID` and `EEWBOT_CF_ACCESS_CLIENT_SECRET`.
The Worker trusts only the native `executionCtx.access` context and requires
`access.aud === ACCESS_AUD` before routing, body parsing or any D1 access. HTTP
identity headers are never trusted.

| Status | Code | Meaning |
| --- | --- | --- |
| 503 | `access_not_configured` | `ACCESS_AUD` unset or blank: everything is denied |
| 403 | `access_required` | No native Access context |
| 403 | `access_forbidden` | Access context for a different application |

Access itself may answer with a redirect or 401/403 before the Worker runs.

## Conventions

- Every Worker response carries `Cache-Control: no-store`. Snapshots contain
  webhook credentials; never cache or log them.
- Errors are `{"error":{"code":"<code>"}}`. Unknown paths and methods return
  `404 not_found`; malformed JSON returns `400 invalid_json`; storage failures
  return `503 storage_unavailable`; bugs return `500 internal_error`.
- Request bodies are JSON. **Unknown fields are ignored**, so Core can add fields
  before the Worker knows them.
- Snowflakes are canonical decimal strings, never JSON numbers.

## Delivery configuration

| Request | Success |
| --- | --- |
| `GET /config/revision` | `{"revision":0}` |
| `GET /config/snapshot` | `{"revision":0,"destinations":[]}` |

`revision` increases by exactly one for every committed configuration change.
The snapshot is one SQL statement, so its `revision` always matches its
`destinations`, which are ordered by `targetId`.

| Destination field | Type |
| --- | --- |
| `targetId` | The thread ID for thread destinations, else the channel ID |
| `channelId` | The channel (the parent channel for threads) |
| `threadId` | Snowflake or `null` |
| `guildId` | Snowflake, or `null` only for imported legacy rows |
| `eewAlert`, `eewPrediction`, `eewDecimation`, `quakeInfo`, `tsunami` | boolean |
| `minIntensity` | Java `SeismicIntensity` code: 0 unknown, 1–4, 5 = 5-lower, 6 = 5-upper, 7 = 6-lower, 8 = 6-upper, 9 = 7 |
| `lang` | `ja_jp`, `en_us`, `zh_tw`, `ko_hanja` or `ko_kp` |
| `webhook` | `{"id","token"}` or `null`. Every target, including each thread, has its own webhook |

Core builds the execute URL itself:
`https://discord.com/api/webhooks/{id}/{token}`, plus `?thread_id={threadId}`
for threads.

Poll `revision` and load a snapshot after it changes, keeping the snapshot's own
revision. On any failure keep the last good snapshot and retry with backoff;
never replace it with an empty configuration.

## Cleanup

| Request (`POST /cleanup/...`) | Body | Success |
| --- | --- | --- |
| `/guild` | `{"guildId":"…"}` | `{"affected":2}` |
| `/destinations` | `{"targetIds":["…"]}` | `{"affected":1}` |
| `/webhooks` | `{"targets":[{"targetId":"…","expectedWebhookId":"…"}]}` | `{"affected":1}` |
| `/webhook-ids` | `{"webhookIds":["…"]}` | `{"affected":1}` |

Lists hold at most 500 entries; empty lists are no-ops. Invalid IDs return
`400 invalid_request`. `affected` is the number of destination rows changed, and
the configuration revision advances once per call that changed rows.

- `/guild` deletes every destination of the guild.
- `/destinations` deletes exactly the listed targets (no thread cascade).
- `/webhooks` clears the webhook only while the target still holds the expected
  webhook, so a replacement made by `/setup` is never cleared.
- `/webhook-ids` clears every destination holding one of the webhook IDs.

Each call is one D1 transaction. Repeating a call is a no-op against unchanged
state, but it is not a durable idempotency key: a delayed delete can remove a
destination that was registered again in the meantime.

## Legacy migration

`POST /migration/destinations` imports destinations from the legacy Java Core
store (SQLite/PostgreSQL) during the cutover. Core reads its own table and sends
it in chunks.

```json
{ "destinations": [ { "targetId": "…", "channelId": "…", "threadId": null, "guildId": "…",
  "eewAlert": true, "eewPrediction": false, "eewDecimation": false, "quakeInfo": true,
  "tsunami": true, "minIntensity": 1, "lang": "ja_jp",
  "webhook": { "id": "…", "token": "…" } } ] }
```

Each entry has exactly the snapshot destination shape (all fields required;
`guildId` and `webhook` may be `null`). Success is `{"affected":2}`.

- At most 500 entries per call, with unique `targetId`s; the whole call is one
  D1 statement, so it is all or nothing.
- Every entry is an upsert by `targetId` that **overwrites** the stored row,
  including one registered through Discord. A row that already holds identical
  values is not counted, so resending a chunk is a no-op, and the revision
  advances once per call that changed rows.
- The identity follows the table CHECKs: a channel has `threadId: null` and
  `channelId == targetId`; a thread has `threadId == targetId` and its parent
  as `channelId`.
- `webhook.token` must match `[A-Za-z0-9_-]{20,256}` (the rule Core applies to snapshots): the token alone, without
  the legacy URL's `?thread_id=` suffix. Legacy threads share their parent's
  webhook; that is accepted as is.
- `lang` must be one of the five lower-case codes. Any invalid entry rejects the
  whole call with `400 invalid_request`, so Core must normalize or skip legacy
  rows (and log them) before sending.
- Rows are never deleted: the import does not remove destinations that are
  missing from the legacy store.

## Earthquake information

Core publishes the latest report; the Worker keeps only that one and serves it
to `/quakeinfo`.

### `PUT /quakeinfo/latest`

```json
{
  "eventId": "20260101000000",
  "reportType": "VXSE53",
  "reportDateTime": "2026-01-01T00:00:00Z",
  "dateTime": "2026-01-01T00:00:00Z",
  "serial": 1,
  "infoType": "発表",
  "languages": {
    "ja_jp": [[{ "title": "…" }], [{ "title": "…" }]],
    "en_us": [[{ "title": "…" }]],
    "zh_tw": [[{ "title": "…" }]],
    "ko_hanja": [[{ "title": "…" }]],
    "ko_kp": [[{ "title": "…" }]]
  }
}
```

| Field | Rule |
| --- | --- |
| `eventId` | `[A-Za-z0-9_-]{1,64}` |
| `reportType` | `VXSE51`, `VXSE52`, `VXSE53` or `VXSE61` |
| `reportDateTime`, `dateTime` | UTC ISO-8601 instant (up to nanoseconds) or `null` |
| `serial` | Signed 32-bit integer; Core sends -1 when the telegram has none |
| `infoType` | `発表`, `訂正` or `取消` (priority 0, 1, 2) |
| `languages` | All five languages; each is 1–16 Discord messages of 1–10 embed objects |

Embeds are rendered by Core and checked only for shape; Discord's own embed
limits are Core's responsibility.

Response `200 {"accepted":true,"revision":7}` stores the report as the new
latest. `200 {"accepted":false,"revision":7}` means the stored report is strictly
newer, so nothing changed. Reports are ordered like Java `QuakeInfoStore`:
`(reportDateTime ?? "", dateTime ?? "", serial, infoTypePriority)`, with times
normalized to nine fractional digits. An equal key with different content
replaces the stored report (a re-render); an identical report is accepted
without a write, so Core's periodic re-sends and retries never advance
`revision`. Invalid bodies return `400 invalid_quakeinfo`. There is no body size
limit beyond Workers' own; Core keeps a report under about 2 MiB.

The write is one D1 transaction: the report row and its messages change
together, and the previous report's messages are deleted.

### `GET /quakeinfo/latest?lang=ja_jp`

For operations and integration tests; Core does not need it. `lang` defaults to
`ja_jp`; an unknown language returns `400 invalid_language`.

```json
{
  "revision": 7,
  "snapshot": {
    "eventId": "20260101000000",
    "reportType": "VXSE53",
    "reportDateTime": "2026-01-01T00:00:00.000000000Z",
    "dateTime": "2026-01-01T00:00:00.000000000Z",
    "serial": 1,
    "infoType": "発表",
    "infoTypePriority": 0,
    "updatedAt": 1767225600000
  },
  "lang": "ja_jp",
  "messages": [{ "messageIndex": 0, "embeds": [{ "title": "…" }] }]
}
```

Before the first publication, `snapshot` is `null` and `messages` is empty.
