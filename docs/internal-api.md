# Internal configuration API v2

Base path: `/internal/v2`. Consumer: EEWBot Java Core (`RemoteConfigApiClient`,
`RemoteDestinationConfigSource`, `RevisionPoller`). Version 2 replaced v1 on
2026-10-31; v1 paths now return 404.

## Authentication

The whole `/internal` subtree (including unknown paths and every method) is
protected by Cloudflare Access with a Service Auth policy. The client sends
`CF-Access-Client-Id` and `CF-Access-Client-Secret`. The Worker then checks the
native `executionCtx.access` context and requires `access.aud === ACCESS_AUD`
before routing, method checks, body parsing or any D1 access. HTTP identity
headers are never trusted.

| Status | Code | Meaning |
| --- | --- | --- |
| 503 | `access_not_configured` | `ACCESS_AUD` unset or blank: everything is denied |
| 403 | `access_required` | No native Access context |
| 403 | `access_forbidden` | Access context for a different application |

Access itself may answer with a redirect or 401/403 before the Worker runs.

## Conventions

- Every Worker response carries `Cache-Control: no-store`. Snapshots contain
  webhook credentials; never cache or log them.
- Errors: `{"error":{"code":"<code>"}}`. Codes are stable and secret-free.
- Known path with the wrong method: `405 method_not_allowed` with an `Allow` header.
  GET routes also answer HEAD.
- Unknown or non-canonical path (percent-encoded or `//`): `404 not_found`.
- Query parameters are rejected (`400 invalid_query`) unless a route lists them.
- Storage failure: `503 storage_unavailable`. Unexpected bug: `500 internal_error`
  (logged as `internal_unhandled_error`, without details).

## Endpoints

| Request | Success |
| --- | --- |
| `GET /internal/v2/meta` | `{"apiVersion":2,"capabilities":["configRevision","deliverySnapshot"]}` |
| `GET /internal/v2/config/revision` | `{"revision":0}` |
| `GET /internal/v2/config/snapshot` | `{"revision":0,"destinations":[]}` |

`revision` is a monotonically increasing integer (JSON number ≤ 2^53−1). Every
committed configuration change advances it exactly once; read-only requests
never change it. The snapshot is read in a single SQL statement, so its
`revision` always matches its `destinations`. Destinations are ordered by
`targetId` (text order).

### Destination

| Field | Type |
| --- | --- |
| `targetId` | Snowflake string. The thread ID for thread destinations, else the channel ID |
| `channelId` | Snowflake string (the parent channel for threads) |
| `threadId` | Snowflake string or `null` |
| `guildId` | Snowflake string or `null` (only for imported legacy rows) |
| `eewAlert`, `eewPrediction`, `eewDecimation`, `quakeInfo`, `tsunami` | boolean |
| `minIntensity` | Java `SeismicIntensity` code: 0 unknown, 1–4, 5 = 5-lower, 6 = 5-upper, 7 = 6-lower, 8 = 6-upper, 9 = 7 |
| `lang` | One of `ja_jp`, `en_us`, `zh_tw`, `ko_hanja`, `ko_kp` |
| `webhook` | `{"id": Snowflake string, "token": string matching `[A-Za-z0-9_-]{20,256}`}` or `null` |

Core builds the execute URL itself:
`https://discord.com/api/webhooks/{id}/{token}`, plus `?thread_id={threadId}`
when `threadId` is non-null.

Synthetic example:

```json
{
  "revision": 1,
  "destinations": [{
    "targetId": "1234567890123456791",
    "channelId": "1234567890123456790",
    "threadId": "1234567890123456791",
    "guildId": "1234567890123456789",
    "eewAlert": true,
    "eewPrediction": false,
    "eewDecimation": true,
    "quakeInfo": false,
    "tsunami": true,
    "minIntensity": 4,
    "lang": "en_us",
    "webhook": { "id": "1234567890123456792", "token": "synthetic-token-xxxxxxxxxxxx" }
  }]
}
```

## Client guidance

Check `meta` (`apiVersion == 2` and the capabilities) at startup, poll
`revision`, and load a full snapshot after it changes. Replace the in-memory
configuration using the **snapshot's own** revision. On any authentication,
transport or parse failure, keep the last good snapshot and retry with backoff;
never replace it with an empty configuration.
