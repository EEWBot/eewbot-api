# Phase 1 verification — 2026-10-26–27

> **Historical record.** This log predates the 2026-10-31 production-readiness
> refactor (internal API v2, squashed schema, removal of `/ping`). Paths,
> table names and migration numbers below describe the system at that time.

## Source and scope

- API base: master `52b78d2cc7e0e7499b6aa2bb2f38819e598e12f9`.
- Branch: `feat/discord-setup-interactions`.
- Java reference checkout: `bfce06494e8bb49cd3d94877bd0d0aa8b01fc586`.
- No production deployment, production D1 operation, production bot change,
  production command registration or automatic merge was performed.

## Local verification

| Check | Result |
| --- | --- |
| `npm ci` | PASS, exact lockfile installation |
| `npm run check` | PASS |
| `npm test` | PASS: 301 Workers/D1 tests plus 4 Node registration tests = **305** |
| Existing API tests | All **185** preserved and passing |
| Added tests | **116** signed settings/D1/REST tests plus **4** registration tests |
| `npm run build` | PASS: staging and production dry-run bundles; no production publication |
| `npm run test:java` | PASS: 7 HTTP/RevisionPoller convergence checkpoints |
| `git diff --check` | PASS |

The settings suite generates temporary Ed25519 keys, signs real raw request
bodies, uses official Workers ExecutionContexts, mocks Discord REST and applies
actual migrations to local D1. No real Discord credential or network is required.
The migration is additive and the tests also preserve readable legacy shared
webhook assignments. It tests CAS races, rollback, expiry inside mutation SQL,
actor/channel isolation, revoked permissions on selects/buttons, replay receipts,
parent/thread locks and independent deletion, webhook failures and orphan cleanup,
REST timeouts, secret suppression, safe mentions and unchanged internal snapshot
publication.

The thread-permission correction adds ten regression cases. Setup succeeds
without parent Send Messages when Send Messages in Threads is available, both
through guild roles and parent overwrites. Both REST-calculated permissions and
signed app permissions must independently include View Channel and the send
permission appropriate to the target. Missing either permission rejects setup
without registering a destination or creating a webhook.

Java 25 compiled the actual reference Core HTTP client, config source, snapshot
registry, DeliverySnapshot and RevisionPoller against its existing shadowJar. The
test used only a fresh local D1, synthetic credentials and a loopback HTTP adapter;
it did not log in to Discord Gateway. The actual observed checkpoints were:

| Checkpoint | Committed revision | Java observation |
| --- | --- | --- |
| Channel registration + webhook | 2 | Channel and defaults present |
| Channel Base settings | 3 | `eewAlert` and `quakeInfo` enabled |
| Channel intensity | 4 | Numeric code 7 (6 weak) |
| Thread registration + separate webhook | 6 | Parent ID and thread ID preserved |
| Thread settings | 9 | Tsunami, decimation, intensity 9; independent webhook URL/thread query |
| Parent unregister | 10 | Parent absent; thread retained |
| Thread unregister | 11 | Snapshot empty |

At each checkpoint the harness compared every snapshot field, including all
flags, language and webhook fields, with committed D1 data. Only checkpoint names
and revisions were printed. The poller, rather than a direct reload call, caused
Java to obtain each new snapshot.

## Deployed staging verification

Final staging Worker version: `fe1fabd1-c747-471a-b7b0-777c483cebb6`.
Endpoint: `https://api-staging.eewbot.net`.
Database: existing `eewbot-staging` / `30988518-b77a-4f66-806e-52f266a2aeda`.

- Applied `0002_discord_interactions.sql` successfully; migration history now has
  two entries. Existing destination data was not initialized or rewritten.
- D1 revision stayed **13 → 13** and destination count **0 → 0** across the initial
  migration/disabled staging verification on October 26. The authorized live
  Discord test on October 27 advanced revision **13 → 25** and restored the
  original empty destination list after independent Channel/Thread unregister.
- `/health`: PASS, HTTP 200.
- Unsigned `/interactions`: PASS, HTTP 401.
- Anonymous and forged-credential Internal API access: PASS, denied.
- Existing Access Service Token: PASS, authenticated meta/revision/snapshot GETs,
  HTTP 200 and `Cache-Control: no-store`; no credentials/snapshot bodies logged.
- Authenticated `/internal/v1/cleanup/meta`: PASS, HTTP 200 and no-store.
- Staging command switch: **true**, pinned to test Application
  `350178549782544384` and Guild `564550533973540885`. Existing `ACCESS_AUD`
  was preserved. `DISCORD_BOT_TOKEN` and the matching application public key are
  staging Worker Secrets. No new production bindings exist.

The ordinary CI/deployment workflow is unchanged. The PR's GitHub Actions checks
provide the authoritative CI result for its final commit. A master push can
replace this temporary unmerged branch deployment, as before.

## Live Discord + real staging Java verification — October 27

The operator supplied the test Application/Guild IDs and authorized the Bot Token
in local `config.json`. A Bot-authenticated Application lookup verified the token
belongs to **EEWBot Dev**, Application `350178549782544384`, before any secret or
command write. The existing Interactions Endpoint URL already matched staging.
The token was transferred to the staging Worker Secret through process stdin;
neither the token nor raw Discord responses containing credentials were printed
or committed. The matching public key was taken from the verified Application.

The registration script individually upserted the three guild-scoped commands:

| Command | Test Guild command ID | Default member permissions |
| --- | --- | --- |
| `/ping` | `1563637820181053531` | Unrestricted |
| `/setup` | `1564348331046473808` | `32` (Manage Guild) |
| `/unregister` | `1564348332061622362` | `32` (Manage Guild) |

Global and unrelated command definitions were not deleted or modified. The real
Discord desktop client, using the operator's existing login, invoked only
**EEWBot Dev** commands in the specified Guild:

- Parent: `dev-test`, Channel `716105005957906443`.
- Dedicated public test Thread: `1564350751931895838`, named
  `eewbot-api-staging-20261027`, created under that parent by the test bot.

An actual Java Core observer ran simultaneously against the fixed HTTPS staging
origin, with the existing Access Service Token loaded only into its process. It
used the real RemoteConfigApiClient, RemoteDestinationConfigSource,
SnapshotDeliveryRegistry and RevisionPoller sources listed above, polling every
second. There was no Discord Gateway login, direct snapshot reload, synthetic
Access context, or direct SQL configuration mutation in this live flow. Each
checkpoint compared all fields of the HTTP D1 snapshot with the polled Java
delivery snapshot. Only IDs, flags, revision and safe webhook metadata were logged.

| Real UI / verification action | Revision | Result in D1 and Java |
| --- | --- | --- |
| Baseline | 13 | No destinations |
| Parent `/setup` | 15 | Defaults registered; existing bot webhook reused |
| Base menu: alert + quake info | 16 | Both true; other Base flags false |
| Modifier menu: decimation | 17 | `eewDecimation=true`; Base unchanged |
| Minimum intensity: 6 weak | 18 | Numeric code `7` |
| Thread `/setup` | 20 | Independent defaults and new dedicated webhook |
| Thread Base: tsunami | 21 | `tsunami=true`; parent unchanged |
| Thread Modifier + intensity: 7 | 23 | Decimation true, numeric code `9`; parent intensity stays `7` |
| Old parent menu after Thread updates | 23 | Reopen-command error; snapshot unchanged |
| Parent `/unregister` → Cancel | 23 | Cancellation response; snapshot unchanged |
| Parent `/unregister` → Confirm | 24 | Parent removed; Thread and its settings retained |
| Thread `/unregister` → Confirm | 25 | Thread removed; snapshot empty |
| Final preservation check | 25 | Original destination list restored exactly |

Parent webhook ID `1191320820820217877` was reused. Before Thread setup, it was
the only test-bot-owned webhook in the parent. Thread setup therefore created
new webhook `1564351466167210135`; its saved URL retained
`thread_id=1564350751931895838`. The two destinations never shared a webhook ID.
Webhook tokens and full URLs were neither displayed in Discord nor recorded here.
Every setup/menu/error/confirmation/cancellation response displayed
**Only you can see this** in the actual client.

The dedicated test Thread was archived after both D1 targets were removed.
Webhooks remain available for later reuse, matching Java unregister behavior;
existing webhooks and other Guild destinations were not deleted. The Java
observer was stopped after the final preservation check. D1 revision was never
reset. Final health, unsigned-signature rejection, Access denial and authenticated
Internal reads passed again with commands enabled.

No Discord/Cloudflare configuration remains missing for this staging scope.
Permission-denial, malformed input, HTTP failure and concurrency cases remain
covered by the credential-free local suite; the real client test used the
operator's server-owner account. Production activation remains outside scope.

## Follow-up scope

Later PRs can port `/lang`, `/quakeinfo`, `/testmessage`, `/help`, `/invite` and
broader localization. Production Application switching, production migration or
deployment, a web administration UI and Java Core configuration writes remain
outside this phase.
