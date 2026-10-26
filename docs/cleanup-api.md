# Internal cleanup API v1 (staging)

This API is exclusively for Java Core cleanup. There is no general destination
creation/editing endpoint. Production configuration and deployment are unchanged.

## Access setup

Use the existing internal Access application protecting
`api-staging.eewbot.net/internal/*` (and its parent `/internal`, as already set up).
Its existing **Service Auth** policy and Service Token authorize both snapshots
and cleanup writes. No new Application, AUD, Service Token or policy is required.
Keep `/health` and `/interactions` public, with no Bypass or broad user Allow rule
on the internal subtree. This common-token operation is intentional for the
current Core-only usage; it does not provide separate read/write permissions.
See [Cloudflare application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

Retain native Access validation/context for the existing application and its
staging Worker secret `ACCESS_AUD` (`wrangler secret put ACCESS_AUD --env staging`
if setup is needed). Do not introduce `ACCESS_CLEANUP_AUD` or cleanup-only secrets.
Use secure secret entry; never put service secrets in command arguments, Git,
config.json, HTTP body logging, or CI output. Java uses environment variables
`EEWBOT_CF_ACCESS_CLIENT_ID` and `EEWBOT_CF_ACCESS_CLIENT_SECRET` for both clients.

Worker authorization uses only native `executionCtx.access.aud`, matched exactly
against `ACCESS_AUD`. Every internal path/method, including unknown cleanup ones,
is authorized before routing/body parsing/DB access. Missing AUD returns 503;
missing/mismatched context returns 403. HTTP identity headers are never trusted.
The same context can read snapshots. Noncanonical encoded or double-slash paths
are rejected. Common auth failure denies reads/writes; Interactions stay separate.
Authentication middleware is independent of cleanup routing/storage. If different
consumers eventually need different permissions, introduce separate authorization
and inject separate credentials into Java's independent HTTP clients then. Do not
reuse this common Service Token for future Discord user command authorization.

## Contract

All Worker responses have `Cache-Control: no-store`. Use `application/json` for
POST. Limits are **500 input entries before deduplication** and **131072 actual
UTF-8 body bytes**, including whitespace. Empty lists are accepted as no-ops.
Snowflakes are canonical positive unsigned 64-bit decimal strings, never Numbers.
Extra/missing fields, invalid IDs/JSON/UTF-8 return 400; excess bytes return 413.
Unknown routes or methods return 404 (GET-only reader paths still use 405).
Storage failures return sanitized 503, without SQL, causes, tokens or snapshots.

| Method/path under `/internal/v1/cleanup` | Request | Success |
| --- | --- | --- |
| GET `/meta` | none | `{"apiVersion":1,"capabilities":["destinationCleanup"]}` |
| POST `/guild` | `{"guildId":"1234567890123456789"}` | `{"affected":2}` |
| POST `/destinations` | `{"targetIds":["1234567890123456790"]}` | `{"affected":1}` |
| POST `/webhooks` | `{"targets":[{"targetId":"1234567890123456790","expectedWebhookId":"1234567890123456792"}]}` | `{"affected":1}` |
| POST `/webhook-ids` | `{"webhookIds":["1234567890123456792"]}` | `{"affected":1}` |

POST success is always HTTP 200, including `affected:0`. `affected` is the number
of destination rows actually changed. Duplicate matches count only once. Guild
deletes all its destinations; target deletion is exact, without sibling/thread
cascade. Webhook operations null both `webhook_url` and `webhook_id`. `/webhooks`
compares both target and expected webhook ID to protect a replacement webhook.
`/webhook-ids` matches all destinations sharing an ID, regardless of `thread_id`.
Full webhook URLs/tokens are never needed in these requests or responses.

## Atomicity, replay and remaining races

Each operation uses one DELETE/UPDATE and one conditional revision UPDATE in one
D1 `batch()` transaction. JSON string arrays are bound through `json_each(?)`,
avoiding per-target transactions, SQL interpolation and parameter limits.
The adjacent revision statement checks `changes()>0`: exactly one increment per
changed batch and none for empty/no-match/already-cleared operations. A failure
rolls back the mutation and revision together. Snapshot reads are one statement.
Local D1 tests inject revision failures to verify rollback for all four operations.

Replaying an operation against unchanged state is a no-op. This is **not durable
idempotency**: a delayed/retried delete may remove a newly recreated destination
with the same target/guild ID. A webhook ID reused on a target has the same ABA
limitation. No persistent idempotency key or event ordering is provided. Core must
not automatically retry ambiguous writes after timeouts/503. Later independent
events can still affect recreated settings. Cleanup delivery is best effort; a
nonpersistent queue can lose pending notifications on crash/restart.

## Staging verification procedure

1. Pass `npm ci`, `npm run check`, `npm test`, `npm run build`; create API PR.
2. Confirm existing Access application/token and staging `ACCESS_AUD`, then
   `npm run deploy:staging` (never deploy production).
3. With secrets held only in memory, check cleanup meta and snapshot with the same
   common token = 200; unauthenticated/invalid-token cleanup must be denied.
4. Explicitly insert only unique synthetic destination IDs in **eewbot-staging**
   D1 via an approved local maintenance script/CLI, record the current revision,
   and exercise all four cleanup endpoints. Never touch existing IDs. Verify
   counts, conditional webhook replacement, no-op replay, and monotonic revision.
   Do not reset revision to zero. Remove synthetic survivors only.
5. Run Java staging integration with the common credentials, then
   enable `cleanupEnabled` on the identified staging Bot host and restart. If the
   host cannot be accessed, report that cutover as pending.

The actual deployment, Access and integration results must be recorded in the PR;
the procedure alone does not establish that they have been performed.

## Verification status (2026-10-26)

All 185 local tests passed, including 63 cleanup cases against actual migrated
local D1. Type checking and both environment dry-run builds passed. API PR:
[eewbot-api #11](https://github.com/EEWBot/eewbot-api/pull/11).

The implementation and tests follow the updated **common Access** specification.
Staging deployment and actual changed-row D1/Java integration results are recorded
in the PR after verification. No additional Cloudflare authentication setup is
required; the existing shared Token/AUD are used. Production is unchanged.
