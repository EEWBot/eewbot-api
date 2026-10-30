# Discord /quakeinfo

PR C depends on [PR A](https://github.com/EEWBot/eewbot-api/pull/25); until A is
merged, its base is `feat/quakeinfo-snapshot-api`. The Java producer is
[PR B](https://github.com/EEWBot/EEWBot/pull/473). Review A, B, then C; none is
automatically merged. Production Worker/D1/application/global commands are unchanged.

Java Core owns XML parsing, latest selection, correction/cancellation, reference
intensity supplementation, all five language embeds and signed Renderer URLs.
Workers reads saved D1 data and responds to Discord. Command execution never
queries Java Core, a Renderer service, or Webhook Sender. No Renderer HMAC key is
copied to D1 or Workers. A stopped Core leaves the last committed snapshot available.

## Authorization and read behavior

The existing Ed25519 verification covers the raw request body before parsing.
Application/Guild Install/context validation remains enforced, with no fixed Guild ID restriction. See [Global migration](discord-global-commands.md).
`authorizeMember` is used without the settings command's MANAGE_GUILD requirement;
ordinary members can invoke `/quakeinfo`. Interaction token paths are built only
from validated application IDs/tokens, and Discord REST uses a fixed origin.

Language is read from the exact Destination target (`interaction.channel_id`),
so Threads use their own setting independently of the parent. Unregistered targets,
and foreign-Guild rows fall back to ja_jp. The command
neither registers destinations nor writes language/configuration settings.
`config_meta.channels_revision` and `quake_latest.quake_revision` are independent;
the command changes neither.

Five languages are stored in separate rows; each language can have multiple
message rows. `QuakeStore.latest()` joins one committed snapshot and every requested
language message in a single SQL statement, ordered by zero-based message_index.
Even a concurrent commit cannot mix snapshots. The complete returned array is
retained throughout Discord delivery. Snapshot cleanup protects the current
pointer and retains retired snapshots for 24 hours (see snapshot API documentation).

## Discord response

Immediately return public Deferred Response type 5, then do D1/REST work in
`waitUntil`. Edit `@original` with the first message's exact embed array. Send each
remaining array as one followup POST in order. All bodies include
`allowed_mentions: { parse: [] }`. No Bot Token is required to edit/follow up an
interaction; no channel notification/webhook sender path is used.

The first message also shows report issue time, correction/cancellation status
and synchronization time. Reports older than 24 hours (or with unknown issue time)
receive a localized historical-information warning. Embedded timestamps, footer,
images, color, comments and all packed content remain the Java output. The latest
snapshot has no TTL deletion and remains usable during a Core outage.

An interaction ID is claimed once in the shared `interaction_receipts` table for
20 minutes. Duplicate signed delivery does not restart the send loop. Expired
receipts are purged by the cron job. Original PATCH is idempotent and
may retry once; followup POSTs are **never blindly retried** after a timeout/5xx.
If a later send fails, preserve the first embed array, update its content with a
partial-delivery notice and stop. Do not repost already sent pages. The total REST
budget is 25 seconds, individual full responses 2.5 seconds and 64KiB, with redirects
disabled. Diagnostics never include tokens, upstream bodies, stored URLs or SQL.

### Empty state / Java difference

No committed snapshot produces the localized Java
`eewbot.scmd.quakeinfo.error` guidance. It is a **public** edit after the public
defer. Java uses an ephemeral error followup; a deferred response's visibility
cannot be changed. This deliberate difference keeps all D1 work outside Discord's
initial three-second response deadline. Storage failures use the same static error.

## Registration and manual verification

`scripts/discord-command-definitions.mjs` defines `/quakeinfo` without administrative
default_member_permissions. `npm run register:global-commands -- --env staging
--quakeinfo-only --apply` individually upserts just this Global Command into the selected staging Application after checking the token's
application identity. Other Guild and all Global Commands are preserved.
Do not use a production token or alter IDs. The user confirmed actual Discord
behavior on 2026-10-30 JST; `/help`'s staging-unavailable note was then removed.

Run `npm ci`, `npm run check`, `npm test`, `npm run build`, then `npm run test:java`
with `EEWBOT_CORE_DIR` pointing at PR B's built checkout. CI pins that exact Core
commit. Local D1 and synthetic signing/Access credentials require no real accounts
or external requests. The Java HTTP test parses the existing VXSE53 fixture,
generates five languages and real multi-message pagination, exercises stage/commit,
older/corrected/cancelled reports, sends signed interactions, compares Discord
embed arrays, stops the Java process and verifies responses continue unchanged.

Live verification is explicit and staging-only:

```text
npm run db:migrate:staging
npm run deploy:staging
node --env-file=<existing-local-dotenv> scripts/verify-quakeinfo-staging.mjs
node --env-file=<existing-local-dotenv> scripts/verify-quakeinfo-staging.mjs --normal-only
```

The last form prepares five languages with three messages each for manual Discord
verification. The probe uses the **existing shared Access Service Token** through
EEWBOT_CF_ACCESS_CLIENT_ID/SECRET (the live verifier can map legacy local
API_CLIENT_ID/SECRET names in memory). It never issues credentials or saves them.
It refuses to replace non-test staging data, pins the host/database/application,
uses a historical year-2000 report with conspicuous TEST labels, and never invokes
ordinary notification delivery. Only generated Renderer URLs are stored.
Results under ignored `.wrangler/quakeinfo-staging/` contain metadata/counts only.
See `docs/quakeinfo-verification.md` for performed checks and the remaining state.
