# Discord commands

Seven Global Commands, all Guild Install only (`integration_types: [0]`,
`contexts: [0, 1]`): available in guilds and DMs with the bot. Definitions live in
`scripts/discord-command-definitions.mjs`. These are Discord's
[GUILD and BOT_DM contexts](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-object-interaction-context-types).

Command descriptions use Discord's native
[application command localization](https://docs.discord.com/developers/interactions/application-commands#localization).
The default description is English; `description_localizations` registers
Japanese (`ja`), English (`en-US` and `en-GB`), and available Traditional Chinese
(`zh-TW`) descriptions. Discord displays them according
to the user's client language, independently of the destination's `/lang` setting.
The text comes from Core's `eewbot.scmd.<command>.description` keys in `ja_JP`
and `en_US`, plus `zh_TW` descriptions reused from existing help translations,
synced into `src/i18n/command-descriptions.json` by `npm run i18n:sync`.
Traditional Chinese covers `/setup`, `/lang`, `/help`, `/invite`, `/testmessage`,
and `/quakeinfo`; `/unregister` uses the default English description until a
translation is available.

| Command | Who | Reply |
| --- | --- | --- |
| `/setup` | Manage Guild | Ephemeral menus for the channel's settings |
| `/unregister` | Manage Guild | Ephemeral confirmation, then removes the channel |
| `/lang` | Manage Guild | Ephemeral language menu |
| `/help` | Everyone | Public help embed in the channel language |
| `/invite` | Everyone | Ephemeral invite URL |
| `/testmessage` | Everyone | Sends a test message; ephemeral result |
| `/quakeinfo` | Everyone | Posts the latest earthquake report publicly |

In DMs, the invoking user can manage their own notification settings without
Manage Guild. DM destinations use bot messages, have no webhook, and store
`guildId: null`. The language menu only changes that DM's language and omits the
guild-wide apply button.

## Request handling

`POST /interactions` verifies the Ed25519 signature over the raw body and
rejects timestamps older than five minutes, then:

1. **Authorization** (`src/discord/authorize.ts`). Commands are always enabled.
   The interaction must belong to `DISCORD_APPLICATION_ID` and carry valid IDs
   and `app_permissions`. Guild interactions use `member` and its permissions;
   bot DMs use `user` and require `context: 1` and a DM channel. Settings commands
   and their components need Manage Guild (or Administrator) in guilds. Discord
   enforces the Guild Install installation context through the command definitions.
2. **Routing** (`src/discord/router.ts`). `/help` and `/invite` answer at once.
   Every other command is acknowledged at once (deferred) and finishes in
   `waitUntil()` by editing the original response.

The delivery target comes from the signed interaction: a text or announcement
channel is its own target; a thread is the target under its parent channel
(`interaction.channel.parent_id`). A bot DM is its own target with no guild or
thread. Other channel types are rejected. Guild permission checks use Discord's
computed `app_permissions`; DMs do not have guild view/send/webhook permissions.

Discord does not redeliver interactions, so no receipts are stored. Every
outgoing HTTP request has a five-second timeout; webhook-creating and
message-posting POSTs are never retried, and editing the original response is
retried once.

## `/setup` and `/unregister`

In guilds, `/setup` requires the bot to view and send in the channel (Send Messages in
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

Private menus, option descriptions, saved-setting replies, permission warnings,
unregister controls, invite replies and test-message results prefer the invoking
user's Discord `locale`. `ja` maps to `ja_jp`, `en-US` and `en-GB` to `en_us`, and
`zh-TW` to `zh_tw`. Missing or unsupported locales fall back to the destination's
language, then Japanese; Discord's generic `ko` keeps the selected Core Korean
variant. This does not change the stored notification language. The five supported
languages and shared command text are generated from Java Core's language JSON files;
missing translations fall back to Japanese. Help links, headings and line breaks
are preserved exactly; translation errors are fixed in Core and synced here.
Additional messages follow the existing command keys, such as
`eewbot.scmd.testmessage.error.*` and `eewbot.scmd.lang.*`; common errors use
`eewbot.scmd.error.*`. They are defined in Core in Japanese and English only.
Other languages fall back to Japanese for those messages, including apply
counts and delivery errors. Existing shared translations
remain available in all five languages. Authorization and dispatch failures before
language lookup use the user locale with Japanese fallback. Public `/help`,
`/quakeinfo` and delivered test embeds use the configured destination language.
See [localization](../README.md#localization) for
syncing the generated catalog and checking it against Core.

## `/lang`

Registers the channel with defaults if needed and shows a language select
(`eewlang:s`) and "apply to all channels" button (`eewlang:a`). The button sets
the channel's current language on every destination of the guild. In DMs only
the select is shown; guild-wide apply actions are rejected. Replies use the
user's Discord locale when supported; selecting a notification language still
changes only the destination setting and the selected menu option.

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
language, using embeds only: the first message by editing the deferred response,
the rest as follow-ups. If a follow-up fails, the first message is kept with a
note in content and nothing is resent. Before the first publication or when
retrieval fails, the Java error message is shown in content.

## Image recovery button

Core adds a secondary `eewimage:refresh` button to image-bearing notification
messages, including bot and webhook deliveries. Anyone who can use the button
can request a refresh. The Worker acknowledges with a deferred message update,
then PATCHes the clicked message through the interaction webhook with only
`{ "components": [] }`. Content, embeds and attachments are preserved; the
recovery button is removed. A failed edit is reported in an ephemeral follow-up
without replacing the original notification. This does not require D1 or a bot
token. `/quakeinfo` messages are excluded.

## Registration

```sh
# Every write needs an explicit environment and --apply; the default is a dry run.
npm run register:global-commands -- --env staging --dry-run
npm run register:global-commands -- --env staging --apply
npm run register:global-commands -- --env staging --apply --command help --command invite
```

The registrar upserts each command individually (preserving IDs and unrelated
commands), reads the collection back with `with_localizations=true` to verify
the descriptions and translations, and checks
`GET /oauth2/applications/@me` against the environment's application ID before
any write. A full `--apply` also deletes the retired commands in
`retiredGlobalCommands` (the old `/ping`).

Supply `DISCORD_STAGING_BOT_TOKEN` in the environment. Production needs
`DISCORD_PRODUCTION_BOT_TOKEN` and `--confirm-production-application <id>`.
