# EEWBot API

Hono + Cloudflare Workers + D1 backend for EEWBot. It serves Discord HTTP
Interactions (slash commands and components) and a Cloudflare Access protected
internal API that EEWBot Java Core uses to read the delivery configuration,
clean up stale destinations and publish earthquake information snapshots.

## Endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | public | Liveness check: `{"status":"ok"}` |
| `POST /interactions` | Discord Ed25519 signature | Discord Interactions Endpoint URL |
| `/internal/v2/config/{revision,snapshot}` | Cloudflare Access | Delivery configuration for Core |
| `/internal/v2/cleanup/*` | Cloudflare Access | Destination/webhook cleanup by Core |
| `/internal/v2/quakeinfo/latest` | Cloudflare Access | Latest earthquake report: PUT by Core, GET for operations |

The internal contract is in [docs/internal-api.md](docs/internal-api.md).

Discord commands (Global, Guild Install only): `/setup`, `/unregister`, `/lang`
(require Manage Guild), `/help`, `/invite`, `/testmessage`, `/quakeinfo`. See
[docs/discord-commands.md](docs/discord-commands.md).

Every internal error is `{"error":{"code":"<code>"}}` with `Cache-Control: no-store`.
Snowflake IDs are always JSON **strings**; never pass them through JavaScript `Number`.

## Code layout

```
src/
  index.ts              Worker entry: routes and /interactions
  log.ts                Structured JSON logging (never log tokens, URLs or caught errors)
  env.ts                Worker bindings
  http/                 Internal API plumbing: ApiError + error handler, JSON body, validators
  middleware/           Cloudflare Access (native context AUD) authorization
  routes/               /internal, /internal/v2/cleanup, /internal/v2/quakeinfo
  db/                   Destination store (D1), types, validation, StorageError
  quakeinfo/            Latest earthquake report store and validation
  discord/
    router.ts           Declarative handler table: match → authorize → ACK → waitUntil(process)
    verify.ts           Signature/timestamp verification over the raw body
    authorize.ts        Common authorization → validated GuildInteraction
    *-command.ts        One module per command family
    rest.ts, http.ts    Discord REST with a per-request timeout
    constants.ts        Permission bits, channel types and timeouts
  i18n/                 Translations (Java-compatible languages)
migrations/                 D1 schema (0001 squashed schema, 0002 simplification)
```

## Local development

Requires Node.js 22+.

```sh
npm ci
cp .dev.vars.example .dev.vars.staging   # set the TEST application's public key
npm run db:migrate:local
npm run dev
```

Quality gates (all run in CI):

```sh
npm run lint     # Biome (format + lint); `npm run format` applies fixes
npm run check    # TypeScript (strict, noUncheckedIndexedAccess for src)
npm test         # Node script tests + Vitest in the Workers runtime with local D1
npm run build    # wrangler deploy --dry-run for staging and production
```

Tests use generated Ed25519 keys, synthetic Access contexts and the real
migration on local D1; they need no Discord or Cloudflare credentials.
`npm run test:java` additionally drives the actual Java Core (set
`EEWBOT_CORE_DIR` to a Core checkout with a built shadowJar).

## Localization

Java Core's `src/main/resources/lang/languages.json` and `lang/*/eewbot.json`
are the source of truth for supported languages and shared slash-command text.
`src/i18n/core-messages.ts` is generated and checked in so the Worker can build
independently of the Core checkout. Missing keys fall back to Japanese, as in
Core. Values are preserved exactly, including line breaks and links. Translation
errors are corrected in Core before regenerating this catalog.
API-only validation, transport and report guidance remains in the API catalogs.

After updating the Core translations, run these commands from the API directory:

```sh
npm run i18n:sync
npm run i18n:check
```

Both default to the parent directory as the Core checkout; set `EEWBOT_CORE_DIR`
for another location. Commit the generated catalog with the change. The CI Java
job runs `i18n:check` against its pinned Core reference to detect translation drift;
update that reference when adopting newer Core translations.

## Environments

| | Staging | Production |
| --- | --- | --- |
| URL | `https://api-staging.eewbot.net` | `https://api.eewbot.net` |
| Worker | `eewbot-api-staging` | `eewbot-api-production` |
| Discord Application | Separate test application | Existing EEWBot application |
| D1 | `eewbot-staging-v2` | `eewbot-production` (create before first deploy) |
| Commands | Enabled | `DISCORD_COMMANDS_ENABLED=false` until cut-over |
| Deployment | Automatic on `master` (when enabled) | Manual workflow dispatch with environment approval |

Both environments have Workers Logs (`observability`) enabled. Every deployment
command selects an environment explicitly; there is no generic `deploy` script.

### Secrets (per environment, `npx wrangler secret put <NAME> --env <env>`)

| Secret | Purpose |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Verifies interaction signatures |
| `DISCORD_BOT_TOKEN` | REST calls for `/setup`, `/unregister`, `/lang`, `/testmessage` |
| `ACCESS_AUD` | Cloudflare Access application audience; unset ⇒ every internal request is denied (503) |
| `WEBHOOK_SENDER_URL`, `WEBHOOK_SENDER_AUTH_TOKEN`, optional `WEBHOOK_SENDER_ACCESS_CLIENT_ID`/`_SECRET` | Optional Webhook Sender for `/testmessage` |

### Production preparation

1. `npx wrangler d1 create eewbot-production` and put the returned ID into
   `env.production.d1_databases[0].database_id` in `wrangler.jsonc`.
2. Set `env.production.vars.DISCORD_APPLICATION_ID` to the production application ID.
3. Set the secrets above for `--env production`, and protect
   `api.eewbot.net/internal` and `/internal/*` with an Access application whose AUD
   goes into `ACCESS_AUD` (same steps as staging below).
4. Run the **Deploy to Cloudflare** workflow with `environment=production`
   (or `npm run db:migrate:production && npm run deploy:production`).
   `scripts/check-d1.mjs` refuses to touch remote D1 while a placeholder ID remains.
5. Register Global Commands (`npm run register:global-commands -- --env production
   --confirm-production-application <id> --apply`), switch the application's
   Interactions Endpoint URL, and only then set `DISCORD_COMMANDS_ENABLED=true`.
   For one application, Gateway and HTTP Interactions are mutually exclusive.

## Cloudflare Access for `/internal`

Protect only `<host>/internal` and `<host>/internal/*` with one self-hosted
Access application whose single **Service Auth** policy includes only the Core
Service Token. Keep `/health` and `/interactions` public. Store the
application's AUD tag as the `ACCESS_AUD` secret. The Worker trusts only the
native `executionCtx.access` context (never headers) and requires an exact AUD
match. Core sends `CF-Access-Client-Id`/`CF-Access-Client-Secret`.

`node scripts/smoke-staging.mjs` checks health, unsigned interaction rejection and
anonymous internal denial; with `ACCESS_CLIENT_ID`/`ACCESS_CLIENT_SECRET` in the
environment it also checks authenticated reads. It never prints bodies or credentials.

## Discord test application (staging)

1. Create a separate Discord application; set its public key and bot token as
   staging secrets.
2. Set its Interactions Endpoint URL to `https://api-staging.eewbot.net/interactions`.
3. With `DISCORD_STAGING_BOT_TOKEN` in the environment run
   `npm run register:global-commands -- --env staging --dry-run`, then `--apply`.
   A full registration also deletes retired commands (the old diagnostic `/ping`).


## Storage

See [D1 storage](docs/d1-storage.md). The schema is in `migrations/`; Wrangler
tracks applied migrations in `d1_migrations`. All timestamps are Unix
milliseconds.

## CI / CD

- **CI** (PRs, `master`): lint, type-check, tests, dry-run builds, and the Java Core
  integration harness against a pinned Core commit.
- **Deploy** (`deploy.yml`): enabled by the repository variable
  `CLOUDFLARE_DEPLOY_ENABLED=true` with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`
  in the GitHub `staging`/`production` environments. `master` pushes deploy staging
  (migrate → deploy → smoke). Production is deployed only by manual dispatch, which
  should be protected by required reviewers on the `production` environment.
