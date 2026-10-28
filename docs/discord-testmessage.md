# Discord `/testmessage`

## Scope and Java compatibility

Ported from Java `TestMessageSlashCommand`, `WebhookSenderClient`,
`WebhookSenderRequest`, `ChannelWebhook`, `ConfigV2.WebhookSender`, and the five
`eewbot.scmd.testmessage.*` catalogs. No Core communication or always-on Java
staging bot is needed. The command requires no Manage Guild permission. Existing
settings commands still require it. The signed Application/Guild/installation
checks apply before any D1 or REST access. Responses use a deferred ephemeral ACK
and edit its original message; the actual embed is posted in the invoking target.
Every message disables mentions. Java's embed title, route descriptions, color
7506394 and result strings are retained. Cosmetic author/avatar/footer fields
are omitted. Error details are static translations rather than upstream text.
Literal English `\\n` sequences in the Java source become real line breaks.

Destination languages `ja_jp`, `en_us`, `zh_tw`, `ko_hanja`, `ko_kp` are supported;
unknown codes and unregistered targets use Japanese. The signed channel ID selects
the D1 row through `D1DestinationStore`; its guild, parent and thread must match
the REST-verified target. There are no options accepting alternate targets.
The command never inserts, updates or removes a destination or webhook and never
advances `config_meta.channels_revision`. Deleted hooks are left to Cleanup.

## Three delivery paths

| D1 webhook | Sender URL | Delivery |
| --- | --- | --- |
| present | valid origin + Bearer (+ optional Access pair) | Sender `POST /api/send` |
| present | unset or empty | Discord Webhook API with `wait=true` |
| absent, including unregistered target | any | Bot `POST /api/v10/channels/{target}/messages` |

Bot sends verify the token's Application, guild/channel and effective Bot
permissions, including View Channel and Send Messages, or Send Messages in Threads
for a thread. Signed `app_permissions` must independently permit the send.
Discord remains authoritative for archived/locked/private thread access and other
permission failures. Sender configuration is checked when a webhook route is used.

Webhook URLs must match the exact unversioned Discord HTTPS path, a positive
unsigned 64-bit Snowflake and a 20–256 character `[A-Za-z0-9_-]` token. The URL ID
must equal the saved `webhook_id`. Only one canonical `thread_id` query is allowed;
it is required for a thread and must equal that verified thread, and is forbidden
for a normal channel. Ports, userinfo, fragments, other queries, alternate hosts,
encoded path tricks and duplicate query parameters are rejected. URLs are rebuilt
from these validated parts on `https://discord.com`, even for Sender targets.

## Sender configuration and credentials

| Binding | Storage | Meaning |
| --- | --- | --- |
| `WEBHOOK_SENDER_URL` | Worker Secret | private configured origin, optional trailing slash |
| `WEBHOOK_SENDER_ACCESS_CLIENT_ID` | Worker Secret | optional Sender Access Service Token ID |
| `WEBHOOK_SENDER_ACCESS_CLIENT_SECRET` | Worker Secret | optional Sender Access Service Token secret |
| `WEBHOOK_SENDER_AUTH_TOKEN` | staging Worker Secret | Sender's own Bearer token |

Set the URL as a Worker Secret; local development may use ignored `.dev.vars`.
The real origin is private and must not appear in Git, public Wrangler vars,
documentation, PR text, test fixtures or CI/build logs. Tests use synthetic origins.
HTTPS is
the default recommendation. The operator authorized HTTP with Bearer and optional
Access on October 28, revising the original HTTPS-only, mandatory-Access requirement.
This applies to any configured origin without host/staging pins or extra permission
flags. Staging uses a private HTTP origin stored as a Secret, together with the
Bearer Secret. HTTP carries that token
without transport encryption, as explicitly authorized. Other environments have
not been configured or deployed. The implementation has no hostname/application/
guild allowlist for Sender configuration; Interaction authorization still pins
the test Application/Guild.

Reject non-origin paths, query/fragment delimiters, userinfo, whitespace and invalid
URLs. HTTP and HTTPS origins are accepted directly. The endpoint is always the statically configured origin plus `/api/send`.
Command options and stored webhook data cannot change the Sender host. Redirects
never forward credentials. Access credentials require HTTPS;
the HTTP mode accepts Bearer only.

Enter each secret interactively, without shell literals, logs or PR text:

```sh
npx wrangler secret put WEBHOOK_SENDER_URL --env staging
npx wrangler secret put WEBHOOK_SENDER_ACCESS_CLIENT_ID --env staging
npx wrangler secret put WEBHOOK_SENDER_ACCESS_CLIENT_SECRET --env staging
npx wrangler secret put WEBHOOK_SENDER_AUTH_TOKEN --env staging
```

For an Access-protected Sender, use a dedicated Cloudflare Access Service Token. Configure its Access
application with a **Service Auth** policy allowing that token; see the
[official service-token instructions](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
The Worker sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` for Access,
and separately `Authorization: Bearer ...` for the Sender. Access success alone
does not authenticate to the Sender. Neither `ACCESS_AUD` nor Core/Internal read
service credentials are used as outbound Sender credentials. These headers are
constructed only for the Sender request, never for Discord. Bearer is always
required for a configured URL. The Access pair can both be unset, or must both be
complete; a missing half fails closed. An invalid URL or Sender
authentication failure never falls back to direct webhook delivery.

The deployment repository pins
[`ghcr.io/eewbot/webhook-sender:v0.4.0`](https://github.com/EEWBot/webhook-sender-deploy/blob/2a1a22508ece6d3dea807d9b9df2b39172c645dc/docker-compose.yml).
The request is a JSON array containing `{ targets: [validatedWebhook], body,
retry_limit: 10 }`, matching Java's default. The current
[`web.rs`](https://github.com/EEWBot/webhook-sender/blob/master/src/web.rs)
returns `200` and `OK` after enqueueing. Both are required for acceptance here;
204, other 2xx or a non-OK 200 are not reported as a queued job. A queue error or
connection close is a failure/unknown result. Acceptance means **queued**, never
Discord delivery confirmation. The five languages use Java's queued wording,
including Japanese 「テストメッセージの配信を予約しました。」.

## HTTP failures and retries

Every HTTP operation has a 2.5-second deadline covering headers and body, with a
64 KiB response limit checked on Content-Length and streamed bytes. The background
operation has a 20-second total budget. All redirects are manual; no Location is
followed. No upstream response body, raw fetch/URL exception or credential is
logged or sent to the user.

| Result | Handling |
| --- | --- |
| Discord 2xx, including 200/204 | sent successfully |
| Sender 200 with `OK` | queued, delivery unconfirmed |
| Sender 401/403 | configuration error, no fallback |
| Discord 403 | missing Bot/webhook permission |
| Direct webhook 404 | webhook may have been deleted; rerun `/setup` |
| 429 | rate limit; wait before trying again |
| 5xx | service unavailable |
| 301/302/307/308, 400, other unexpected statuses | safe generic failure |
| timeout or connection loss during POST | result unknown; check the channel |
| oversized response | safe failure; no retry |

Workers make exactly one delivery POST. Reservations persist even on failures,
including timeouts and 5xx, to avoid automatic duplicate posts. The Sender's own
`retry_limit: 10` is a separate internal delivery policy; it does not cause Worker
HTTP retries. Editing the original ephemeral response is idempotent and retains
the existing bounded retry behavior; a reply failure never repeats the delivery.

## Durable rate limits and migration

`0004_discord_testmessage.sql` adds only an operational reservations table and
indexes, with no revision triggers. A single serialized D1 `batch` transaction
purges expired records, inserts the existing 20-minute interaction receipt and
conditionally inserts a reservation. SQLite `changes()` ties the reservation to
the immediately preceding new receipt. A replay cannot claim it. Predicate checks
and insertion occur in the same transaction across Worker instances.

| Gate | Sliding window |
| --- | --- |
| Channel/Thread target | 1 per 30 seconds |
| Actor across targets | 1 per 60 seconds |
| Guild across actors/targets | 10 per 600 seconds |

These conservative initial limits permit manual checks without enabling member
spam across threads or multiple instances. D1's clock is authoritative. A rejected
interaction receives a receipt, so its replay cannot become a send after cooldown.
Reservations are retained for 10 minutes; receipts for 20 minutes, longer than the
five-minute signature acceptance window. D1 failure or rollback prevents sending.
No HTTP delivery begins before the reservation commits. Checks are operation
state, independent of destination revisions and survive Worker restarts.

## Verification — 2026-10-28 JST

- Base: latest fetched master `67e1fb3d0acedc1b0b338e6018bac966c69055c3`.
- `npm ci`, `npm run check`, `npm test`, `npm run build`: passed. The final full
  suite passed **601 tests** (541 Workers/D1 and 60 Node). The original 410 are
  preserved; **191 cases were added** (135 Workers/D1, 54 real HTTP, 1 registration,
  and 1 check preventing private Sender bindings in public Wrangler vars).
- Added tests use actual local D1 migrations and a real loopback HTTP mock server,
  plus signed Interactions with mocked Discord REST. They cover all three paths,
  all five languages, every specified status/transport failure, headers and
  redirects, oversized/stalled bodies, URL validation, replay, concurrent channel,
  actor/Guild gates, time expiry, D1 rollback and unchanged snapshots/revisions.
  Real credentials are never required by CI.
- `npm run test:java`: passed all 19 existing actual Java Core snapshot,
  RevisionPoller and I18n checkpoints. No Java repository change was needed.
- Staging migration 0004 applied to database
  `30988518-b77a-4f66-806e-52f266a2aeda`. Across migration and deployment, revision
  **41 → 41**, destinations **0 → 0**, testmessage reservations **0**. This proves
  deployment preservation. The later isolated direct-webhook command also preserved
  revision **49 → 49**, as detailed below.
- Staging deployed at `https://api-staging.eewbot.net`, final version
  `6814faa5-8f43-4f09-a350-1c6c83a189fc`, with the private Sender URL stored as a Secret
  after direct-webhook testing. `/testmessage` individually registered as
  command `1564959368317771866` in Guild `564550533973540885`, after verifying Bot
  Application `350178549782544384`. Discord reports unrestricted default member
  permissions. Existing/global commands were not overwritten.
- Health, unsigned Interaction rejection, anonymous/forged Internal API denial
  and unauthenticated Cleanup rejection (401) passed. Authenticated Internal/Cleanup checks require their separate service
  credentials; none were supplied to this run. Local API regressions all passed.
- Direct authenticated Sender connectivity passed: `POST /api/send` with an empty
  JSON array returned **200 OK**, without any Discord target. Missing Bearer returned
  **400** and invalid Bearer **401**. The supplied Bearer was transferred through
  process stdin to `WEBHOOK_SENDER_AUTH_TOKEN` in staging; its value is not in Git,
  documentation, PR or test/CI logs. Access is not deployed on this Sender, so its
  real Access policy remains unverified (the paired-header path is covered locally).
  This probe was from the local process. The operator subsequently reported that
  real Worker-to-Sender queue acceptance and Discord delivery passed for both the
  Channel and Thread, as described below.
- The operator reported **PASS** for the four requested manual checks: Channel Bot
  delivery before setup, immediate-repeat rejection without another post, Channel
  Sender delivery after setup, and both Bot/Sender delivery in a dedicated Thread.
  These are operator-reported observations, not agent UI inspection. The tested
  parent is `dev-test` (`716105005957906443`), Thread `1564377774372687962`.
  A subsequent D1 read found two reservations for each target and revision **49**.
  Setup/unregister operations occurred during this sequence, so **41 → 49** is not
  evidence of revision changes caused by testmessage.
- The operator also reported **PASS** for direct webhook delivery inside the
  registered Thread: an ordinary success response and an embed delivered inside
  that Thread. Staging was temporarily deployed as
  version `6ffd518b-4a76-4588-9e4d-fe6bdb61b49a` with `WEBHOOK_SENDER_URL` empty;
  version metadata confirmed the Bearer Secret was retained. The operator ran only
  testmessage, without setup or settings changes. D1 before/after reads confirmed
  revision **49 → 49**, the same Thread destination metadata, and a new reservation
  for that Thread. The configured Sender URL was then restored by normal staging
  deployment; version metadata confirmed the configured URL and retained Secret,
  and the health/signature/Internal-denial smoke checks passed again.
- The private Sender origin was subsequently migrated from plaintext vars to
  `WEBHOOK_SENDER_URL` as a Worker Secret in one deployment. The real value was
  removed from current configuration, documentation and tests; tests now use a
  synthetic HTTP origin. CLI/build output did not contain the private origin.
  Version metadata confirmed that the URL, Bearer, Bot Token, public key and
  Internal Access audience remained Secret bindings. Revision stayed **49** and
  the health/signature/Internal-denial smoke checks passed after migration.
- Final D1 revision is **49**. The parent is unregistered and the test Thread remains
  registered with its webhook; no cleanup of the operator's registration was made.
  Independent per-actor/per-channel and Guild-wide live boundaries, ordinary-member
  identity and authenticated Internal/Cleanup checks remain covered locally or
  pending separate operator evidence. Direct webhooks in a normal Channel are
  covered locally; the live direct-webhook test used the Thread.
- `/help` removes the testmessage unavailable notice after the staging deployment
  and successful command registration. `/quakeinfo` remains unavailable.
- Production configuration, secrets and deployments have not been changed.
  Production build is a dry run only. No merge or automatic merge is performed.

## Repeat staging and preproduction checks

1. The private Sender URL and Bearer are staging Secrets. If moving to HTTPS/Access,
   configure a Service Auth policy and enter the dedicated Access pair as staging
   Secrets. Probe `POST /api/send` with `[]` and require `200 OK`.
2. Deploy staging and individually register the new command with
   `npm run register:test-command -- --testmessage-only`, using only the pinned
   test Bot Token. The default script still individually upserts all seven commands.
3. In the verified dev-test channel and a dedicated test Thread, execute as an
   ordinary member: Sender webhook, Sender-disabled direct webhook and no-webhook
   Bot sends. Confirm embeds, queued/sent distinction and ephemeral replies.
4. Check channel/user/Guild limits live, compare snapshots/revision immediately
   before and after each `/testmessage`, and regress settings/Internal/Cleanup.
   Intentional `/setup`, `/unregister` or `/lang` fixture changes advance revision
   normally and must be measured separately from testmessage.
5. Before production activation, independently review credentials, Access policy,
   D1 migration, rate values, webhook inventory, permissions, registration and
   error observability. Validate the final CI and staging version. This PR grants
   no production deployment or secret changes. A later master deployment can
   replace the temporary unmerged staging deployment.

## Operator Discord procedure

Use **EEWBot Dev** in Guild `564550533973540885`, channel `dev-test`
(`716105005957906443`). Allow **65 seconds** between intended successful tests;
the actor limit applies across channels and threads. Record the result text,
whether an embed arrived, its description, and whether the result was ephemeral.

1. Before `/setup`, run `/testmessage`: expect a channel embed explaining Webhook
   low-latency delivery is disabled, and an ephemeral send-success result (Bot path).
2. Run it again immediately: expect an ephemeral rate-limit error and no extra
   channel embed. An ordinary member should be able to invoke the command.
3. Run `/setup`, wait for completion, and then `/testmessage` after cooldown:
   expect the low-latency-enabled embed and an ephemeral **queued** result (Sender).
   Record whether the actual embed arrives separately from queue acceptance.
4. Create a dedicated test Thread under dev-test. Before setup, test its Bot path;
   then run `/setup` inside the Thread and test Sender after cooldown. Embeds must
   appear inside that Thread, not the parent.
5. To test direct webhooks, privately retain the Sender origin, temporarily remove
   its staging Secret with `npx wrangler secret delete WEBHOOK_SENDER_URL --env staging`,
   and retain the Bearer Secret. Repeat registered Channel/Thread tests: expect
   ordinary send-success wording, not queued wording. Restore the URL interactively
   with `npx wrangler secret put WEBHOOK_SENDER_URL --env staging` afterward.
   Coordinate this temporary configuration switch with the agent.
6. Compare D1 revision/snapshot immediately before/after each testmessage and
   rate rejection. Setup/unregister/lang are intentional configuration changes,
   so establish a new baseline after each. Run `/help`, `/lang`, `/setup` and
   `/unregister` regression checks and remove only the test registrations afterward.
7. Report Channel/Thread Bot and Sender outcomes first; the agent can check safe
   D1 metadata and arrange the direct-webhook phase. Independent actor/channel,
   Guild-wide and replay boundaries are covered atomically by local D1 tests;
   distinguishing them live needs multiple member accounts and remains pending.
