# Discord setup interactions

`/setup` and `/unregister` run directly against `D1DestinationStore` after the
existing Ed25519 raw-body signature and timestamp checks. No HTTP administration
endpoint is added.

See [Global migration](discord-global-commands.md) for the current registration and cleanup procedure. Historical verification below predates this migration.

## Configuration and registration

Settings commands default to disabled when `DISCORD_COMMANDS_ENABLED` is absent
or is not exactly `true`. Staging is explicitly enabled for Application
`350178549782544384` in any valid Guild Install.
Production keeps `DISCORD_COMMANDS_ENABLED=false` until cut-over. Settings
commands require all three of the following; information commands do not require
the Bot Token:

| Staging binding | Purpose |
| --- | --- |
| `DISCORD_COMMANDS_ENABLED` | Exactly `true` to enable settings commands |
| `DISCORD_APPLICATION_ID` | The separate test Application ID |
| `DISCORD_BOT_TOKEN` | Test Bot Token, stored as a Worker Secret |

The existing test `DISCORD_PUBLIC_KEY` is also required. Settings commands require the staging `DB` binding; `/help` falls back to Japanese if it is unavailable.
Missing or inconsistent configuration fails closed. Do not use the Cloudflare
Access Service Token as a Discord credential. Never configure these bindings on
the production Worker or use the production Application IDs/token.

1. Pin the **test** Application ID in `env.staging.vars` in
   `wrangler.jsonc`. Leave the switch false until credentials and installation are ready.
2. Install the test application in each desired guild as a Guild Install. Give the bot
   View Channel and Manage Webhooks, with Send Messages for normal channels or
   Send Messages in Threads for thread delivery. Threads do not require Send
   Messages in the parent. A user performing setup needs Manage Server or Administrator.
3. Set `DISCORD_BOT_TOKEN` with `npx wrangler secret put DISCORD_BOT_TOKEN --env staging`.
   Enter the token in the secret prompt, never in a command argument or tracked file.
4. Supply that token to the local registration process through the environment
   and run `npm run register:global-commands -- --env staging --dry-run`, then
   `npm run register:global-commands -- --env staging --apply`. It verifies the
   token's Application ID and individually POSTs eight Global Commands with
   `integration_types: [0]` and `contexts: [0]`. No bulk overwrite is used.
   Environment Application ID overrides must equal the pinned ID.
5. Enable only staging and run `npm run db:migrate:staging` and
   `npm run deploy:staging`. Preserve the existing staging-only automatic workflow.

The test Application's Interactions Endpoint URL remains
`https://api-staging.eewbot.net/interactions`. An unmerged branch deployment is
temporary and will be replaced by the existing master deployment workflow.

## Behavior and Java compatibility

New destinations use Java's defaults: all five flags false, `minIntensity=1`,
`lang=ja_jp`, null webhook fields. A thread uses its own ID as `targetId` and
`threadId`, with the REST-verified parent ID as `channelId`. A normal channel's
`targetId` and `channelId` match, and `threadId` is null. Duplicate inserts do not
overwrite an existing destination.

The three select menus display current D1 values. Base values retain
`eewAlert`, `eewPrediction`, `quakeInfo`, `tsunami`; Modifier retains
`eewDecimation`. A selection replaces **all** flags in that group in one mutation.
An empty selection turns that group off and leaves other groups unchanged.
Intensity values are Java numeric codes 0–9 (0 unknown; 5/6 = 5 weak/strong;
7/8 = 6 weak/strong; 9 = 7), rather than Java's former display-string menu values.

Unregister confirmation deletes only the current destination, including when
that destination is a parent with registered threads. Cancel performs no D1
write, including UI bookkeeping. Like Java, unregister leaves the remote webhook
available for later setup reuse.

Differences from the Java UI are deliberate:

- A Guild Install matching the invoking guild is required; no fixed Guild ID is configured; DMs and User Installs
  are rejected. Direct setup supports text/announcement channels and threads under
  text, announcement, forum or media parents.
- Messages are Japanese in this phase; an existing `lang` value is preserved.
- User permissions are checked on every command, select and button, using BigInt.
- Components expire after ten minutes and reject any changed **global** revision,
  even if another destination changed. Users reopen the command to refresh.
- Webhook existence, ownership and current token are validated with the official
  channel-webhooks list API, instead of Java's HEAD request to a stored URL.
- Without Manage Webhooks, setup saves null webhook fields and warns. An existing
  assignment is cleared, rather than retaining a webhook it cannot validate.
- Missing Bot Token explicitly disables these commands. Network failures do not
  assume an existing webhook is valid or display a success menu.

## Authorization and component state

Signature verification completes before **any** D1 access or Discord REST call.
The verified payload must match the configured Application/Guild, have guild
context 0 and the matching Guild Install owner, and have a valid member ID plus
Manage Guild (`32`) or Administrator (`8`) permission. Components repeat this
check, including after a user loses permissions. A REST Application identity check
also prevents use of a different bot's token.

Only the signed `channel_id` selects a REST channel. The bot fetches that channel
and, for threads, its parent, and checks their IDs, guild and supported types.
Command arguments are rejected. Component IDs contain no operation target:
`eew:<32 hex random characters>:<one action character>` (38 characters).
Server-side sessions bind actor, guild, current target, parent, command kind,
revision and expiry. Arbitrary component IDs cannot choose a D1 row. Neither
custom IDs nor public replies contain webhook or interaction credentials.

Commands immediately acknowledge with an ephemeral deferred response (type 5).
Selects/buttons defer an update (type 6) to the same ephemeral message, then replace
its menus/buttons in place. Authentication failures respond ephemerally (type 4).
`waitUntil()` owns bounded background processing; it is not a durable queue.
REST calls have a 2.5-second timeout, a 20-second aggregate deadline, an
18-second pre-mutation budget and a separate five-second error-response budget.
D1 requests cannot be canceled; checks gate further mutations after slow I/O.
Every message uses `allowed_mentions: { parse: [] }`. Transient response edits
are retried once, without repeating configuration writes. REST POST is never
blindly retried. HTTP 403/404/429/5xx and transport exceptions produce sanitized
errors; their response bodies, raw exceptions and token-bearing URLs are discarded.

## D1 atomicity, concurrency and webhooks

UI sessions (`discord_sessions`), interaction receipts (`interaction_receipts`)
and setup locks (`discord_setup_locks`) never enter the snapshot. Reads only
accept live rows; the cron job purges expired ones.

Configuration compare-and-swap checks target identity and global revision in the
**mutation SQL**. For component writes it also checks the session identity and
expiry in that same statement. The mutation and `revision++ WHERE changes()>0`
are adjacent statements in a D1 batch transaction. SQL failure rolls both back.
Zero matched rows do not advance revision. A matched same-value update advances
once, as existing setters do; one group update advances once. Confirm uses the
same contract, so stale/replayed confirmations cannot delete a newer registration.

Setup acquires a durable, 120-second **parent-channel** lease before registration
and webhook discovery/creation. A concurrent setup of the parent or any sibling
thread receives a retry message. Expired leases can be replaced; an old owner
cannot release its successor's lease. Interaction receipts suppress duplicate
side effects for twenty minutes, longer than signature freshness allows replay.

Bot permissions are calculated from REST guild roles/member roles and parent
channel overwrites. Both these effective permissions and signed `app_permissions`
require the same target-specific mask: View Channel plus Send Messages for a
normal channel, or View Channel plus Send Messages in Threads for a thread.
Setup preferentially reuses a valid current or unassigned, bot-created
webhook in the same parent. Assignment SQL requires the current lease and
`NOT EXISTS` any other destination owning that webhook ID, within the revision
transaction. The advisory exclusivity read is never used as an assignment lock.
Channel and thread webhooks therefore stay distinct. Only the webhook ID and
token are stored; the thread query (`?thread_id=<thread ID>`) is added when the
URL is built.

If a new webhook cannot be saved, cleanup first verifies it is not assigned,
then deletes it with bot authentication. Failure logs a static message and target
ID only. If creation times out or returns a potentially ambiguous 5xx, keep the
lease cooldown. Subsequent setup lists/reuses the already-created bot webhook
after expiry. This also reconciles an orphan left by a terminated request, without
creating one webhook per retry. No durable completion or automatic orphan sweep
is promised. Initial registration can remain at safe defaults when later webhook
I/O fails; the response reports failure and never shows a completed setup menu.

## Verification

Run `npm ci`, `npm run check`, `npm test`, `npm run build`. The ordinary suite
uses generated Ed25519 keys, mocked fixed-origin Discord REST, and real local
D1 migrations; no real credentials or Discord network requests are needed.

For the cross-repository HTTP test, build the Java Core shadowJar, set
`EEWBOT_CORE_DIR` to its checkout (the parent directory is the default), optionally
set `EEWBOT_CORE_JAR`, and run `npm run test:java`. This compiles the actual Core
RemoteDestinationConfigSource, HTTP client, SnapshotDeliveryRegistry and
RevisionPoller sources against that jar. A test-only loopback adapter supplies
a synthetic Access context. This adapter is never part of either deploy bundle.

The original seven checkpoints verify signed interactions → local D1 → unchanged HTTP
revision/snapshot endpoints → actual Java immutable delivery snapshots. They cover
channel registration, flags, intensity, thread registration/settings, parent-only
unregister and final thread unregister. No Gateway login occurs.
The harness now includes twelve additional language checkpoints, documented in
[language interactions](discord-lang.md), for nineteen checkpoints total.

See [phase 1 verification results](discord-setup-verification.md) for this branch's
local, CI, staging and outstanding live Discord checks.

Protocol references: [Discord interactions](https://docs.discord.com/developers/interactions/receiving-and-responding),
[permissions](https://docs.discord.com/developers/topics/permissions),
[webhooks](https://docs.discord.com/developers/resources/webhook),
[guild command registration](https://docs.discord.com/developers/interactions/application-commands).

For the public information commands and their verification status, see [information commands](discord-info.md).
