# Staging Discord language interactions

`/lang` ports Java `LangSlashCommand` onto the settings infrastructure from
[PR #12](https://github.com/EEWBot/eewbot-api/pull/12). That PR merged on
2026-10-26 at 20:15:12 UTC. This branch, `feat/discord-lang-interactions`, includes
master `6b9dbb379452a8b3ff5aded328e5cfc6ea868f01` and targets master; it does not
modify or merge #12. The existing master staging deployment succeeded in
[Actions run 40393986832](https://github.com/EEWBot/eewbot-api/actions/runs/40393986832).

## UI and compatibility

One single-select menu and one guild-apply button are ephemeral. The language
catalog in `src/i18n/languages.ts` supplies validation, options, display names,
types, and the three Java translation keys. Missing translations use Japanese.

| Stored code | Display name |
| --- | --- |
| `ja_jp` | 日本語 |
| `en_us` | English, US |
| `zh_tw` | 中文（台灣） |
| `ko_hanja` | 한자 |
| `ko_kp` | 조선어 |

Only one exact lowercase allowlisted string is accepted. Empty, duplicate,
multiple, unknown, uppercase, or incorrectly typed selections are rejected.
Unknown legacy values remain unchanged on opening; Japanese is the display
fallback. Guild apply is disabled until the user explicitly selects a supported
language. Existing storage setters remain compatible with legacy strings.

A missing current destination is inserted without overwriting duplicates, using
Java defaults: all five flags false, intensity 1, language `ja_jp`, null webhook
URL/ID. The signed channel is resolved through Discord REST, including the parent
of a thread. No webhook lookup, creation, deletion, or bot send-permission lookup
occurs for `/lang`. Existing flags, intensity, webhook fields, and IDs stay intact.
The single-target operation changes only that destination's language. Guild apply
uses the source destination's selected language, affects all registered rows with
the same verified guild, includes threads, excludes DM/other guilds, and never
registers additional destinations. Its reply includes the matched row count.

The three success/button translations come from Java resources. Additional count
translations are included; missing error translations fall back to Japanese.
`/setup` and `/unregister` remain Japanese. Unlike the older Java controls,
Workers accepts only the staging Guild Install, checks permissions on every
interaction, expires menus after ten minutes, rejects any changed global
revision, suppresses replayed interactions, and refreshes controls after writes.
No Java runtime change or Java repository PR is needed.

## Authorization, sessions and atomic writes

The existing raw-body Ed25519 verification runs before D1/REST access. The common
settings authorization requires the configured staging switch, Bot Token,
Application/Guild, Guild Install context/owner, valid member, and current
`MANAGE_GUILD` (`32`) or Administrator (`8`) parsed with BigInt. Commands reject
arguments. Select and apply repeat the same checks. REST verifies bot application
identity and current channel/parent/guild/type. IDs supplied in unrelated payload
fields or custom IDs cannot choose the mutation target.

Migration `0003_discord_language_sessions.sql` adds a dedicated language session
table and expiry index; it preserves existing session kinds, destinations and
revision. Sessions contain actor, guild, target, parent, thread, exact source
language, revision, and expiry. Opaque IDs use
`eewlang:<32 random hex characters>:s|a` (42 characters), separate from setup's
namespace. Existing twenty-minute interaction receipts prevent duplicate writes.

`changeLanguageFromSession()` executes one `UPDATE destinations SET lang = ?`,
with either a current-target predicate or a guild predicate. The UPDATE itself
checks the global revision and joins the unexpired session to the still-existing
source row, verifying actor, guild, target, parent, thread, revision, and source
language. For guild apply the requested language must equal the session/source
language, so updating the source does not invalidate the guard for later rows.
The SQL checks remain effective if expiry changes after the handler read.

That UPDATE and the existing `channels_revision++ WHERE changes() > 0` statement
run adjacently in one D1 `batch()` transaction. One or 111 matched rows advance
revision once, including same-value matches. Zero matches advance nothing. SQL
failure rolls back both the destination update and revision. Two operations with
one expected revision cannot both succeed. A new revision/session replaces the
controls after success; an older menu tells the user to reopen `/lang`.
The public revision/snapshot formats, Internal/Cleanup APIs, and webhook locking
contracts are unchanged. See the [D1 batch transaction contract](https://developers.cloudflare.com/d1/worker-api/d1-database/).

Initial commands return ephemeral deferred ACKs; components defer edits to their
existing ephemeral message. `waitUntil()` owns bounded background processing.
Existing REST timeouts/deadlines and safe error handling apply. No uncertain D1
write is retried, even if the write succeeded before an error reached the caller.
All messages disable mentions. Tokens, raw exceptions, and snapshot bodies are
never used as public diagnostics.

## Configuration and rollout

Reuse the existing staging bindings and secrets from [setup](discord-setup.md).
No new credentials or Access policy are needed. Registration individually
upserts `/ping`, `/setup`, `/unregister`, `/lang` in the pinned test guild after
checking token ownership; it does not bulk-overwrite unrelated/global commands.
`/lang` has `default_member_permissions=32` as well as runtime authorization.
Production remains disabled without command vars, Bot Token, or D1 bindings.

Apply migration 0003 before deploying this branch. Its live staging deployment
is temporary: the next master deployment can replace it until this PR is merged.
The existing automatic staging workflow remains unchanged. No automatic merge or
production deployment is performed.

## Verification — 2026-10-27 JST

| Check | Result |
| --- | --- |
| `npm ci`, `npm run check` | PASS |
| `npm test` | PASS: **386** = 382 Workers/D1 + 4 Node registration tests |
| Baseline | All **305** tests retained; **81** language cases added |
| `npm run build` | PASS: staging + production dry runs only |
| `npm run test:java` | PASS: **19** local HTTP/Core checkpoints |
| Staging health/signature/Access smoke | PASS, including authenticated reads |
| Live Discord → staging D1 → actual Java Core | PASS: **19** checkpoints, revision **25 → 41** |

Local cases cover all languages, defaults, current selection, legacy fallback,
wrong input types, preserved settings, thread independence, guild scope, 111-row
bulk update, duplicate deliveries, uncertain-write errors, same-value/zero-row
semantics, racing updates, expiry inside SQL, statement/revision rollback,
signature/config/context/permission/owner isolation, namespaces, and secret-free
errors. Discord REST is mocked and actual SQL migrations run on local D1.

The Java harness uses reference Core `bfce06494e8bb49cd3d94877bd0d0aa8b01fc586`:
the actual RemoteConfigApiClient, RemoteDestinationConfigSource,
SnapshotDeliveryRegistry, DeliverySnapshot, RevisionPoller and I18n resources.
It verifies each snapshot field and resource resolution for each language,
multiple channels plus a thread, one-revision guild apply, preserved non-language
fields, and unchanged foreign-guild/DM fixtures. Its loopback Access adapter and
synthetic credentials are test-only; neither is bundled into the Worker.
The CI Java job checks out that immutable reference and runs the same local
harness without real Discord/Cloudflare credentials or Gateway login.

Live environment: `https://api-staging.eewbot.net`, Worker version
`db1d4c2a-d306-48e3-9c0f-c3ad0bc96563`, existing `eewbot-staging` D1.
Application **350178549782544384** (EEWBot Dev), Guild **564550533973540885**,
Channel **716105005957906443** (`dev-test`), temporary Thread
**1564377774372687962** (`eewbot-api-lang-20261027`). Real Discord UI commands and
components generated the signed requests; no signature bypass was used. Existing
staging secrets were reused without re-uploading them.

| Live operation | Revision | Observed result in D1 and Java Core |
| --- | --- | --- |
| Baseline | 25 | Empty snapshot |
| `/lang` on missing channel | 26 | Defaults, Japanese, no webhook |
| English / Chinese | 27 / 28 | Lowercase `en_us` / `zh_tw`, localized replies |
| One transient Discord REST failure | 28 | Private failure, no write/revision; fresh command used afterward |
| Korean Hanja / Korean KP / Japanese | 29 / 30 / 31 | All five languages selectable and resource-compatible |
| `/lang` on missing thread | 32 | Correct parent/thread IDs, no webhook |
| Thread English only | 33 | Parent stays Japanese |
| Old parent guild-apply button | 33 | Rejected, reopen `/lang`; neither row changed |
| Fresh thread guild apply | 34 | Both rows English, count 2, exactly one revision |
| Existing `/setup` | 35 | Reused parent webhook, language retained |
| Setup warning flag / intensity 3 | 36 / 37 | Existing setup still works |
| Parent language Japanese | 38 | Flag, intensity, webhook unchanged; thread stays English |
| Parent guild apply Japanese | 39 | Count 2, all non-language fields retained |
| Parent `/unregister` Confirm | 40 | Only parent removed, thread retained |
| Thread `/unregister` Confirm | 41 | Empty snapshot restored; Java removes both |

The live Java observer used the existing Access credentials in memory to poll the
real HTTPS revision/snapshot APIs, compared every snapshot field, and resolved
I18n resources without Gateway login. Only safe checkpoint metadata was logged.
The initial destination count was zero and the final count is zero. Revision was
never reset or rolled back. The temporary thread was archived; the pre-existing
setup webhook was retained for normal reuse. The observer was stopped afterward.

Live UI used the authorized server owner. Permission loss, different users,
malformed selections, expiry and SQL races were verified with generated signed
interactions/local D1 rather than changing real guild roles or forging live
Discord signatures. No staging settings remain incomplete for `/lang`.
Pending work is review/merge and its normal master rollout; production and the
remaining command migrations stay outside this change.
