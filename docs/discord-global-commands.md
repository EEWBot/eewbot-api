# Global Commands and common Guild authorization

This is the current registration and authorization specification. Earlier dated
verification reports describe the former fixed test Guild migration stages.
The staging and future production runtime use the same code, with independent
Applications, Workers, D1 bindings and Secrets. There is no Guild allowlist or
scope switch. Production bindings remain absent until a separately approved rollout.

## Runtime authorization and data isolation

The route verifies raw-body Ed25519 signatures and the five-minute timestamp
window before parsing or accessing D1/Discord. Discord PING remains a signed
type-1 PONG exchange without Guild checks.

Commands require `DISCORD_COMMANDS_ENABLED === "true"`, a valid configured
`DISCORD_APPLICATION_ID` matching the signed interaction, a valid `guild_id`,
`context === 0`, and `authorizing_integration_owners["0"] === guild_id`.
Any User Install owner (`"1"`) is rejected, including mixed installs. Channel,
interaction and member user IDs must be valid Snowflakes. Member permissions,
and app permissions when supplied, must be decimal bitfields. The existing
interaction-token format and no-command-arguments checks remain enforced.
`DISCORD_TEST_GUILD_ID` was removed from runtime types, Wrangler vars, local
examples and test bindings. Its absence does not disable commands.

`/setup`, `/unregister`, `/lang` and every associated select/button require
`MANAGE_GUILD` (32) or Administrator (8), including after a user's permissions
change. `/help`, `/invite`, `/testmessage`, `/quakeinfo` need no member
management permission. `/testmessage` retains target, actor and Guild rate limits;
the actor cooldown still applies across guilds.

Mutation and delivery paths verify Discord REST channel Guild and thread-parent
Guild against the signed Guild. D1 destinations must match Guild, target, channel
and thread. Sessions bind Guild, channel, actor, kind, expiry and config revision;
language sessions additionally bind thread and language. A second Guild cannot
reuse a session or a foreign webhook. Webhook reuse requires matching Guild,
channel and bot ownership, plus exclusive assignment. `/lang` Guild-wide apply
updates only that Guild. `/help` and `/quakeinfo` use saved language only for a
matching Guild; a foreign row falls back to Japanese. Tokens and foreign settings
are never returned or logged. Config and earthquake revisions remain independent.

## Registration

Definitions live in `scripts/discord-command-definitions.mjs`. All eight are
`type: 1`, `integration_types: [0]` (Guild Install), `contexts: [0]` (Guild only).
The three management commands set `default_member_permissions: "32"`. Others
explicitly set `null` to clear stale management restrictions. Names, options and
descriptions are preserved, except `/invite` now uses environment-neutral wording.
The invite URL always uses the configured environment's Application ID.

The registrar individually POSTs `/applications/{applicationId}/commands`, then
GETs that collection and verifies the selected definitions, contexts and permissions.
Discord's same-name/same-type upsert preserves command IDs and unrelated slash,
User and Message commands. No bulk overwrite or deletion occurs in this process.
Definite HTTP 429 responses honor Discord's delay with bounded retries; transport
errors and 5xx are reported without exposing HTTP bodies or credentials.
See the [Discord Application Commands reference](https://docs.discord.com/developers/interactions/application-commands).

```sh
# All writes require an explicit environment and --apply. Default is dry-run.
npm run register:global-commands -- --env staging --dry-run
npm run register:global-commands -- --env staging --apply
npm run register:global-commands -- --env staging --apply --command help --command invite
npm run register:global-commands -- --env staging --apply --testmessage-only
npm run register:global-commands -- --env staging --apply --quakeinfo-only
```

A full `--apply` (without `--command` filters) also deletes retired Global
Commands listed in `retiredGlobalCommands` (currently the diagnostic `/ping`).
It never creates Guild Commands. Dry runs generate requests without reading tokens or contacting
Discord. IDs come only from the selected Wrangler environment, and must differ
between staging and production if both are configured. Environment ID overrides
must match. `GET /oauth2/applications/@me` must match before any write.

Supply `DISCORD_STAGING_BOT_TOKEN` through the process environment. The legacy
`DISCORD_BOT_TOKEN` is accepted only for staging. Production requires a separate
`DISCORD_PRODUCTION_BOT_TOKEN` and `--confirm-production-application <actual-id>`.
Missing production Application configuration fails before token access. This PR
uses synthetic mocks for production and never supplies or uses its real token.

## Legacy Guild Command cleanup

Registration never triggers cleanup. Normally, verify Global definitions through
the API and execute them in the Discord client before deleting legacy commands.
Then preview the existing migration Guild's commands:

```sh
npm run cleanup:guild-commands -- --env staging --guild-id 564550533973540885
# After inspecting the printed IDs/names and verifying the client:
npm run cleanup:guild-commands -- --env staging --guild-id 564550533973540885 \
  --delete-legacy-guild-commands --confirm-global-client-verified
```

The cleanup tool is staging-only, validates bot identity, selects only exact known
name/type pairs, and prints IDs/names before any DELETE. It requires all eight
Global definitions to be valid, individually DELETEs candidate IDs, then re-lists
and verifies that unrelated commands remain. Guild IDs are migration arguments
only. Runtime authorization never reads them from arguments or configuration.

The user subsequently explicitly requested deletion while client verification was
unavailable. For that operation the additional flag
`--delete-before-client-verification` replaces the client-confirmed flag. It still
requires `--delete-legacy-guild-commands` and complete Global API verification.
Results record `clientVerified: false`; this does not claim a client test passed.

## Verification — 2026-10-30 JST

- `npm ci`, `npm run check`, `npm test`, `npm run build`: passed. Tests: **68 Node
  tests and 607 Workers/D1 tests**. Both build environments were dry-run only.
- `npm run test:java`: passed **19** configuration checkpoints and the complete
  real Java XML/rendering/publisher → local HTTP/D1 → signed `/quakeinfo` sequence,
  including corrections/cancellation and unchanged config revision. It used the
  existing QuakeInfo publisher Core build; Java sources and Local Interactions
  registration were not changed.
- Two synthetic Guilds have independent signed command authorization, settings,
  language, webhooks, latest snapshot language and Guild rate budgets. Cross-Guild
  sessions/destinations and revoked component permissions are rejected. Existing
  invalid signature/timestamp, DM, User Install and REST parent tests also pass.
- Staging Worker deployed: `99fd93ef-7dba-409a-b14c-1e3009e4d85e`,
  `https://api-staging.eewbot.net`. No D1 migration or Secret change was needed.
- At **20:42 JST**, Global registration and read-back verified every row below.
  Existing unrelated Global commands and IDs were preserved.

| Command | Global ID | Default member permissions | Deleted legacy Guild ID |
| --- | --- | --- | --- |
| setup | 1013514012186640384 | 32 | 1564348331046473808 |
| unregister | 1530154982966431928 | 32 | 1564348332061622362 |
| lang | 1196905303506174093 | 32 | 1564376544921653248 |
| help | 1013888111153004675 | null | none existed |
| invite | 1013514013310713867 | null | none existed |
| testmessage | 1186685115712163851 | null | 1564959368317771866 |
| quakeinfo | 1013888112910418103 | null | 1565406715325845597 |
| ping | 1565691774939173004 | null | 1563637820181053531 |

- At **20:43 JST**, the six legacy commands above were individually deleted from
  Guild `564550533973540885` under the user's additional explicit instruction.
  Re-listing found no remaining Guild commands; all eight Global definitions were
  verified again. No unrelated Guild command existed to remove or preserve.
- Staging regression smoke: health 200, unsigned interaction 401; unauthenticated
  config/Cleanup/QuakeInfo reads 401; authenticated config revision/snapshot,
  Cleanup metadata and QuakeInfo metadata 200 with `Cache-Control: no-store`.
  These checks did not mutate staging destinations, settings or earthquake data.
- The user subsequently confirmed successful Discord client command execution in
  **two or more Guilds** on 2026-10-30 JST. This is user-reported live verification;
  individual command/role coverage and Guild IDs were not specified. Agent-side
  Computer Use access to Discord PTB was unavailable. The two-Guild signed
  automated suite also passed. The earlier cleanup record's `clientVerified: false`
  describes the evidence available when deletion ran and remains unchanged.
- Production Application, commands, endpoint URL, Worker, D1, Service Tokens and
  Secrets were not modified. Production runtime remains unconfigured and disabled.

## Future production handoff and rollback

Before a separately authorized production rollout, verify the real Application
identity, Guild-only installation/context settings, independent DB/Secrets and
Access/Sender bindings. Populate actual production values only; do not copy
staging bindings or invent placeholder production resources. Generate and review
the production dry-run requests before allowing access to its token.

Assign one owner to Global registration. Java `SlashCommandHandler` currently
lists Global commands, deletes names outside its registry and upserts its own
commands. In particular, a Java restart can delete `/ping` and overwrite the
Worker-owned definitions. Stop/disable Java Local Interactions registration and
prevent another Java instance from starting it before running production upserts
or changing the production Interactions Endpoint URL. Preserve Core delivery and
polling while handing registration ownership to the Worker tooling. This PR only
documents that coordination; it does not modify Java, toggle its runtime or move
production interactions. Verify ordinary and management users, all components,
webhook delivery, Access boundaries and both revisions in the rollout environment.

To roll back the Worker, select the recorded previous **staging** deployment and
run `wrangler rollback <previous-version-id> --env staging`. Keep the current
Global Commands unless a reviewed rollback explicitly changes their definitions
through individual Global POSTs. An older fixed-Guild runtime will reject other
guilds again, so coordinate that compatibility limitation before rollback. The
legacy Guild commands were deleted; restoring a Worker does not restore them.
No D1 schema changed, so no reverse migration or destination cleanup is needed.
Never bulk overwrite, mass-delete commands, or use production as a rollback target.
