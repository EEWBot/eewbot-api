# Discord commands

Seven Global Commands, all Guild Install only (`integration_types: [0]`,
`contexts: [0]`). Definitions live in `scripts/discord-command-definitions.mjs`.

| Command | Who | Reply |
| --- | --- | --- |
| `/setup` | Manage Guild | Ephemeral menus for the channel's settings |
| `/unregister` | Manage Guild | Ephemeral confirmation, then removes the channel |
| `/lang` | Manage Guild | Ephemeral language menu |
| `/help` | Everyone | Public help embed in the channel language |
| `/invite` | Everyone | Ephemeral invite URL |
| `/testmessage` | Everyone | Sends a test message; ephemeral result |
| `/quakeinfo` | Everyone | Posts the latest earthquake report publicly |

## Request handling

`POST /interactions` verifies the Ed25519 signature over the raw body and
rejects timestamps older than five minutes, then:

1. **Authorization** (`src/discord/authorize.ts`). Commands must be enabled
   (`DISCORD_COMMANDS_ENABLED=true`), the interaction must belong to
   `DISCORD_APPLICATION_ID`, come from a guild, and carry valid IDs, member
   permissions and `app_permissions`. Settings commands and their components
   also need Manage Guild (or Administrator). Discord enforces the Guild Install
   context through the command definitions.
2. **Routing** (`src/discord/router.ts`). `/help` and `/invite` answer at once.
   Every other command is acknowledged at once (deferred) and finishes in
   `waitUntil()` by editing the original response.

The delivery target comes from the signed interaction: a text or announcement
channel is its own target; a thread is the target under its parent channel
(`interaction.channel.parent_id`). Other channel types are rejected. The bot's
permissions are Discord's computed `app_permissions` for that channel.

Discord does not redeliver interactions, so no receipts are stored. Every
outgoing HTTP request has a five-second timeout; webhook-creating and
message-posting POSTs are never retried, and editing the original response is
retried once.

## `/setup` and `/unregister`

`/setup` requires the bot to view and send in the channel (Send Messages in
Threads for a thread). It registers the target with defaults (nothing enabled,
minimum intensity 1, Japanese) if needed, then, when the bot has Manage
Webhooks, gives the target **its own webhook**:

1. keep the stored webhook while it still exists in the channel and belongs to
   this application;
2. else reuse this application's webhook named `EEWBot-<targetId>`;
3. else create one with that name. If storing it fails, the new webhook is
   deleted again.

Thread webhooks are created in the parent channel and used with `thread_id`.
Without Manage Webhooks the target is registered without a webhook and the menu
says so.

The menus (`eew:b` base flags, `eew:m` decimation, `eew:i` minimum intensity)
change the channel they are used in; menus are ephemeral, so only the invoker
can use them. Each change is applied directly, so concurrent edits are last
write wins. `/unregister` shows localized confirm (`eew:c`) and cancel (`eew:x`) buttons.

Menus, option descriptions, saved-setting replies, permission warnings and
unregister controls use the destination's language. The five supported languages
and shared command text are generated from Java Core's language JSON files;
missing translations fall back to Japanese. Help links, headings and line breaks
are preserved exactly; translation errors are fixed in Core and synced here.
API-only messages (`eewbot.scmd.api.*`) are defined in Core in Japanese and English
only. Other languages fall back to Japanese for those messages, including apply
counts, delivery errors, report headings and warnings. Existing shared translations
remain available in all five languages. Invite text uses the configured channel
language too. Authorization and dispatch failures before language lookup use
Japanese. See [localization](../README.md#localization) for
syncing the generated catalog and checking it against Core.

## `/lang`

Registers the channel with defaults if needed and shows a language select
(`eewlang:s`) and "apply to all channels" button (`eewlang:a`). The button sets
the channel's current language on every destination of the guild. Replies use
the selected language.

## `/testmessage`

Sends one embed through the route real deliveries would use, and never changes
configuration.

| Stored webhook | `WEBHOOK_SENDER_URL` | Route |
| --- | --- | --- |
| yes | set | Webhook Sender `POST /api/send` (Bearer, optional Access pair) |
| yes | unset | Discord webhook with `wait=true` |
| no | any | Bot message; requires view and send permissions |

One run per target every 30 seconds (`testmessage_cooldowns`). A transport
failure is reported as "result uncertain" and never retried, because the message
may already have been delivered. Sender secrets are Worker Secrets; the Sender
origin is private and must not appear in Git, docs or logs.

## `/quakeinfo`

Posts the latest report published by Core (see the
[internal API](internal-api.md#earthquake-information)) in the channel's
language: the first message by editing the deferred response, the rest as
follow-ups. If a follow-up fails, the first message is kept with a note and
nothing is resent. Reports older than 24 hours carry a warning. Before the first
publication, the Java "no data" message is shown.

## Registration

```sh
# Every write needs an explicit environment and --apply; the default is a dry run.
npm run register:global-commands -- --env staging --dry-run
npm run register:global-commands -- --env staging --apply
npm run register:global-commands -- --env staging --apply --command help --command invite
```

The registrar upserts each command individually (preserving IDs and unrelated
commands), reads the collection back to verify it, and checks
`GET /oauth2/applications/@me` against the environment's application ID before
any write. A full `--apply` also deletes the retired commands in
`retiredGlobalCommands` (the old `/ping`).

Supply `DISCORD_STAGING_BOT_TOKEN` in the environment. Production needs
`DISCORD_PRODUCTION_BOT_TOKEN` and `--confirm-production-application <id>`.
