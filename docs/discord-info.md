# Staging information commands

`/help` sends a public embed; `/invite` sends an ephemeral application invitation. Both work without Manage Server permission or a Bot Token. After
signature and timestamp verification, commands require the enabled environment
Application, a valid Guild Install for the invoking guild, and a valid interaction.
DMs and User Installs are rejected. `/setup`, `/unregister`, `/lang`, and their components additionally
require Manage Server or Administrator and retain their Bot Token requirements.

Help reads the current channel or thread destination using its ID. It uses its
language only when the stored guild matches; absent destinations,
failed or slow reads fall back to `ja_jp`. It never creates a destination, changes
D1 or advances the revision. Java Help strings are used for the five languages in
the generated Core catalog; missing keys fall back to Japanese. Text, headings,
links and their order match the Java resources exactly. `/testmessage` was
subsequently deployed and individually registered in staging; see
[its delivery and verification notes](discord-testmessage.md).
Help is public, like Java, and disables mentions. The initial response waits at
most 1.5 seconds for D1. See [localization](../README.md#localization) for syncing.

The invite URL uses the verified interaction's matching configured
Application ID, Discord's HTTPS OAuth2 endpoint, and `bot applications.commands`.
No token or user-provided URL is included. The permission mask is **275414830144**:
Java's **275414829120** plus `VIEW_CHANNEL` (1024), which is needed by setup's
channel checks and thread visibility. It retains Java's other requested permissions.
Channel-specific overwrites can still deny access; see [Discord permissions](https://docs.discord.com/developers/topics/permissions).

The registration script checks token ownership, then individually upserts eight
Global Commands for the explicitly selected environment. Only settings commands carry default permission
32. It preserves unrelated commands and command types. See [Global migration](discord-global-commands.md). No schema migration or new
secret is required for the Worker.

## Verification — 2026-10-27 JST

- `npm ci`, `npm run check`, `npm test`, `npm run build`: passed locally.
  410 tests passed (406 Workers/D1 + 4 registration); 18 cases were added.
- `npm run test:java`: passed 19 local Java Core integration checkpoints.
- Staging deployed to `api-staging.eewbot.net`, version
  `10d55eb9-88ba-42a8-9593-5b0e2dd4a208`; before/after D1 revision 41 → 41
  for the deployment and smoke checks. This does not establish a live command result.
- Health, unsigned interaction rejection and unauthenticated Internal API denial
  passed, as did unauthenticated Cleanup rejection (HTTP 401). Authenticated Internal/Cleanup checks were unavailable without Access
  credentials; the local tests cover both APIs.
- Registration and live Discord tests are pending: the local process did not have
  the staging Bot Token. No real `/help`, `/invite`, `/lang`, or normal-user result
  is claimed. The local tests use signed interactions and actual local D1.

To finish: provide the existing staging Bot Token to the registration process and
run `npm run register:global-commands -- --env staging --apply`; execute `/help` and `/invite` as an ordinary
member and verify the URL, languages and public/ephemeral visibility. Verify
`/lang`, `/setup`, `/unregister`, and authenticated Internal/Cleanup access.
Record revision before and after; only intentional `/lang` changes should advance
it for information-command testing. An unmerged staging deployment can be
replaced by master. After merge, verify the master deployment and repeat these
checks against its version; never deploy to production for this change.
