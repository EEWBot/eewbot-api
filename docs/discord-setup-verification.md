# Phase 1 verification — 2026-10-26

## Source and scope

- API base: master `52b78d2cc7e0e7499b6aa2bb2f38819e598e12f9`.
- Branch: `feat/discord-setup-interactions`.
- Java reference checkout: `bfce06494e8bb49cd3d94877bd0d0aa8b01fc586`.
- No production deployment, production D1 operation, production bot change,
  command registration or automatic merge was performed.

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

Final staging Worker version: `dab20e3e-5cd1-4a1a-a90a-3ba4159012e4`.
Endpoint: `https://api-staging.eewbot.net`.
Database: existing `eewbot-staging` / `30988518-b77a-4f66-806e-52f266a2aeda`.

- Applied `0002_discord_interactions.sql` successfully; migration history now has
  two entries. Existing destination data was not initialized or rewritten.
- D1 revision stayed **13 → 13** and destination count **0 → 0** across migration
  and staging verification. No live destination fixture was inserted or deleted.
- `/health`: PASS, HTTP 200.
- Unsigned `/interactions`: PASS, HTTP 401.
- Anonymous and forged-credential Internal API access: PASS, denied.
- Existing Access Service Token: PASS, authenticated meta/revision/snapshot GETs,
  HTTP 200 and `Cache-Control: no-store`; no credentials/snapshot bodies logged.
- Authenticated `/internal/v1/cleanup/meta`: PASS, HTTP 200 and no-store.
- Staging command switch: **false**. Existing `ACCESS_AUD` and test
  `DISCORD_PUBLIC_KEY` secrets were preserved. No new production bindings exist.

The ordinary CI/deployment workflow is unchanged. The PR's GitHub Actions checks
provide the authoritative CI result for its final commit. A master push can
replace this temporary unmerged branch deployment, as before.

## Live Discord verification still required

Actual Discord UI operation is **not verified**. At investigation time, staging
had only `ACCESS_AUD` and `DISCORD_PUBLIC_KEY` secrets. No test Bot Token or pinned
Application/Guild IDs were available. The implementation therefore remains
disabled and the real command-registration script was not run. No setup/webhook
success is claimed for the real Discord Application.

Remaining setup: supply the separate test Application/Guild IDs, test Channel and
Thread IDs, set `DISCORD_BOT_TOKEN` as a staging Worker Secret, verify the test
Guild Install and bot permissions, individually register the commands, then set
only staging `DISCORD_COMMANDS_ENABLED=true` and redeploy. Follow
[configuration instructions](discord-setup.md#configuration-and-registration).

After that, record actual `/setup`, all three menus, Channel/Thread webhook
creation/reuse and `/unregister` Confirm/Cancel. Check the real internal revision
and snapshot plus Java polling using the existing Service Token. Change only the
specified test Guild destinations; never reset D1 or its revision.

## Follow-up scope

Later PRs can port `/lang`, `/quakeinfo`, `/testmessage`, `/help`, `/invite` and
broader localization. Production Application switching, production migration or
deployment, a web administration UI and Java Core configuration writes remain
outside this phase.
