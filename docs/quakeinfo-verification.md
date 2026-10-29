# QuakeInfo verification record

Environment: staging only, checked 2026-10-30 JST. No production deployment,
production migration, production Discord Application/Global Commands, new Access
token or merge was performed.

## Performed live checks

- Migration 0004 applied to eewbot-staging D1
  `30988518-b77a-4f66-806e-52f266a2aeda` (11 statements succeeded).
- Worker `eewbot-api-staging`, route `api-staging.eewbot.net`; API deployment
  `f308a60a-4edd-423a-bc91-12bbc05feb5c`, command deployment
  `eac91b04-b2e7-4944-9926-ac95aeb92b98`.
- Unauthenticated POST/GET rejected with 401 by real Access. Existing shared
  Service Token authenticated successfully; latest/meta returned 200 + no-store.
- Actual Java Core parsed the existing VXSE53 XML and generated five languages
  using existing I18n/EmbedPacker/EmbedRenderer/RendererQueryFactory.
- Normal and corrected fixtures saved three messages for each of five languages;
  cancellation saved one for each. All API read embed arrays exactly matched Java.
- Before each commit, the prior pointer remained published. An older report's
  commit returned 409. Corrections/cancellations updated the published metadata.
- The real asynchronous Java publisher acquired epoch 2 after the manual client,
  converged, then stopped; the last cancellation remained readable. Cleanup kept
  the latest snapshot; existing Internal/meta and Cleanup/meta still returned v1.
- channels_revision remained **49** throughout, independently of quake_revision.
- Direct read-only staging D1 queries confirmed 15 separate current message rows:
  en_us 14106 bytes, ja_jp 14094, ko_hanja 14099, ko_kp 14097, zh_tw 14070
  (three rows per language; totals are measured UTF-8 bytes).
- `/quakeinfo` alone was individually upserted into staging Application
  `350178549782544384`, Guild `564550533973540885`, without admin permission defaults.
  Existing commands and Global Commands were preserved.

## State left for the user's manual Discord verification

After automated correction/cancellation checks, a newer marked historical TEST
normal report was intentionally published for multi-message UI verification:

- snapshot_id: `c4105ccd-abb6-4a5a-8042-94d2a077e3d6`
- publisher_epoch: 3; quake_revision: 5; channels_revision: 49
- reportDateTime: 2000-01-01T00:01:00Z
- ja_jp / en_us / zh_tw / ko_hanja / ko_kp: **3 messages each**
- Publisher/probe process stopped. The Worker alone can read/respond.
- Clearly marked TEST DATA, with historical timestamp and stale-information warning.
- No ordinary destination was notified. Any Discord command execution is limited
  to the fixed staging Guild and is performed by the user.

The user performed the actual Discord UI check and confirmed **正常に表示された**
on 2026-10-30 JST. The test was performed with Java Publisher stopped and the
three-message TEST fixture above. `/help`'s staging-unavailable note was removed
after that confirmation. Automated signed-interaction tests separately verify
exact Java embed arrays and ordering for all five languages, correction/cancellation,
no-data behavior and Java process exit; the user's confirmation is the live UI evidence.

## Automated checks

API/Discord tests cover common Access authentication before D1, schema/media/byte
limits, independent language/message rows, incomplete snapshots, immutable retries,
transaction rollback, source/epoch/sequence ordering, concurrent commit and cleanup.
Discord tests cover ordinary permissions, channel/thread language and fallback,
public defer/edit/followups, no-data/correction/cancellation, snapshot isolation,
ambiguous POST and signed-delivery duplicate suppression, signature/Guild rejection
and configuration immutability. Java tests cover four XML types, all languages,
packing/images, reference enrichment, initial long feed, render version races,
retry/reconciliation/fencing and bounded/sanitized HTTP.

Cross-repository CI pins immutable commits: PR A/C builds PR B Core; PR B builds
the snapshot API test driver from PR A. All new integration jobs use local
Miniflare/D1, synthetic Access/Discord credentials and no external network.

Local final Workers checks: npm ci, npm run check, npm test (61 Node tests and
592 Vitest tests), npm run build (staging/production dry-run only), npm run test:java
(existing 19 checkpoints plus the new actual Java/signed quakeinfo pipeline) passed.
PR A's test/java-core jobs and PR B's existing build, new local-workers job,
CodeQL/actionlint/Gradle dependency checks all passed on GitHub Actions.
Local Java final checks: `gradlew test shadowJar` passed (702 tests, zero failures,
one skipped opt-in test). No local config, credentials, database or logs were committed.
