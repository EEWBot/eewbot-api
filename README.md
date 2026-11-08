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
| `POST /internal/v2/migration/destinations` | Cloudflare Access | One-off bulk import of the legacy Java Core destinations; disabled unless `MIGRATION_API_ENABLED=true` |

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
  routes/               /internal, /internal/v2/{cleanup,quakeinfo,migration}
  db/                   Destination store (D1), types, validation, StorageError
  quakeinfo/            Latest earthquake report store and validation
  discord/
    router.ts           Declarative handler table: match → authorize → ACK → waitUntil(process)
    verify.ts           Signature/timestamp verification over the raw body
    authorize.ts        Common authorization → validated AuthorizedInteraction
    *-command.ts        One module per command family
    rest.ts, http.ts    Discord REST with a per-request timeout
    constants.ts        Permission bits, channel types and timeouts
  i18n/                 Translations (Java-compatible languages)
migrations/                 D1 schema (0001 consolidated schema)
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
`npm run test:java:import` runs Core's legacy import CLI (`RemoteDestinationImport`)
from a synthetic legacy SQLite store into local D1. Both commands run in CI
against the same pinned Core commit.

## Localization

Java Core's `src/main/resources/lang/languages.json` and `lang/*/eewbot.json`
are the source of truth for supported languages and all slash-command text.
`src/i18n/core-messages.ts` is generated and checked in so the Worker can build
independently of the Core checkout. Missing keys fall back to Japanese, as in
Core. Values are preserved exactly, including line breaks and links. Translation
errors are corrected in Core before regenerating this catalog.
Additional messages follow the existing `eewbot.scmd.<command>.*` keys; common
command errors use `eewbot.scmd.error.*`. These messages are defined only in `ja_JP` and `en_US`.
Chinese and both Korean locales fall back to Japanese for these keys while
retaining their existing shared translations. The API modules contain key mappings,
not translation copies. Private interaction replies prefer Discord's user `locale`,
then the configured destination language, then Japanese. Public help, earthquake
reports and delivered test embeds use the destination language. Authorization and
dispatch errors use the user locale with Japanese fallback.

After updating the Core translations, run these commands from the API directory:

```sh
npm run i18n:sync
npm run i18n:check
```

Both default to the parent directory as the Core checkout; set `EEWBOT_CORE_DIR`
for another location. Commit both generated catalogs with the change:
`src/i18n/core-messages.ts` for replies and `src/i18n/command-descriptions.json`
for the Node.js command registrar. Do not edit these catalogs by hand. The CI Java
job runs `i18n:check` against its pinned Core reference to detect translation drift;
update that reference when adopting newer Core translations.

## Environments

| | Staging | Production |
| --- | --- | --- |
| URL | `https://api-staging.eewbot.net` | `https://api.eewbot.net` |
| Worker | `eewbot-api-staging` | `eewbot-api-production` |
| Discord Application | Separate test application | Existing EEWBot application |
| D1 | `eewbot-staging` | `eewbot-production` (create before first deploy) |
| Commands | Always enabled | Always enabled |
| Deployment | Automatic on `master` (when enabled) | Manual workflow dispatch with environment approval |

Both environments have Workers Logs (`observability`) enabled. Every deployment
command selects an environment explicitly; there is no generic `deploy` script.

### Legacy migration API

The migration API is disabled by default in both environments. To run the
one-off import, set `env.<environment>.vars.MIGRATION_API_ENABLED` to `"true"`
in `wrangler.jsonc` and deploy that environment. For local development, set
`MIGRATION_API_ENABLED=true` in `.dev.vars.staging`. Cloudflare Access is still
required. Any value other than the exact string `"true"` (including an unset
variable) returns `503 migration_disabled` before body parsing or DB access.
After the import, set it back to `"false"` and redeploy. See
[the migration contract](docs/internal-api.md#legacy-migration).

### Secrets (per environment, `npx wrangler secret put <NAME> --env <env>`)

| Secret | Purpose |
| --- | --- |
| `DISCORD_PUBLIC_KEY` | Verifies interaction signatures |
| `DISCORD_BOT_TOKEN` | REST calls for `/setup`, `/unregister`, `/lang`, `/testmessage` |
| `ACCESS_AUD` | Cloudflare Access application audience; unset ⇒ every internal request is denied (503) |
| `WEBHOOK_SENDER_URL`, `WEBHOOK_SENDER_AUTH_TOKEN`, optional `WEBHOOK_SENDER_ACCESS_CLIENT_ID`/`_SECRET` | Optional Webhook Sender for `/testmessage` |

### Production preparation

1. Before attaching a production domain, create a **production-only** Access
   Service Token and self-hosted application covering both `api.eewbot.net/internal`
   and `api.eewbot.net/internal/*`. Its only policy must be **Service Auth** with
   an Include rule selecting that exact token. Do not authorize the staging token
   or add Bypass, Everyone or Any service token rules. Verify the staging
   application does not authorize the production token either.
2. Create a separate `eewbot-production` D1 database if it does not exist, and put
   its returned UUID into `env.production.d1_databases[0].database_id`. Never reuse
   the staging database. Set `env.production.vars.DISCORD_APPLICATION_ID` to the
   production Discord application ID.
3. For the first deployment, bootstrap the Worker with **no routes/custom domains**,
   `workers_dev=false` and `preview_urls=false`, then register the production Worker
   Secrets above, including the production Access application's `ACCESS_AUD`.
   Keep all entry points disabled until the Access application and Secrets exist.
   Missing AUD or native Access context always denies internal requests before DB
   access; a missing Discord public key also denies Interactions.
4. Create the GitHub `production` environment, restrict deployments to `master`
   and configure its required reviewers. Store `CLOUDFLARE_API_TOKEN` (a separate
   production deployment token), `CLOUDFLARE_ACCOUNT_ID`, `ACCESS_CLIENT_ID` and
   `ACCESS_CLIENT_SECRET` in this environment. The Access pair is the production
   Core Service Token used for authenticated smoke tests; it is not a Worker
   binding or the Cloudflare deployment API token. Never store these credentials
   as repository-wide secrets or print them in logs.
5. Run the **Deploy to Cloudflare** workflow with `environment=production`
   (or `npm run db:migrate:production && npm run deploy:production`).
   `scripts/check-d1.mjs` refuses to touch remote D1 while a placeholder ID remains.
   The workflow refuses production deployment without the smoke credentials, and
   verifies anonymous/forged denial, authenticated reads and rejection of the
   production token by staging. A 503 is not a successful production auth check.
   For a local deployment, run `node scripts/smoke-api.mjs production` with the
   production Access pair in the environment before proceeding.
6. Only after successful smoke tests, import the legacy destinations and verify
   the Core configuration cutover before switching production Discord traffic.
   Keep `MIGRATION_API_ENABLED=false` except during the authenticated import.
   Register Global Commands (`npm run register:global-commands -- --env production
   --confirm-production-application <id> --apply`), then switch the application's
   Interactions Endpoint URL. Commands are always enabled.
   For one application, Gateway and HTTP Interactions are mutually exclusive.

## Cloudflare Access for `/internal`

Protect only `<host>/internal` and `<host>/internal/*` with one self-hosted
Access application whose single **Service Auth** policy includes only the Core
Service Token. Keep `/health` and `/interactions` public. Store the
application's AUD tag as the `ACCESS_AUD` secret. The Worker trusts only the
native `executionCtx.access` context (never headers) and requires an exact AUD
match. Core sends `CF-Access-Client-Id`/`CF-Access-Client-Secret`.

`node scripts/smoke-api.mjs staging` (`smoke-staging.mjs` is a compatibility wrapper)
checks health, unsigned interaction rejection and
anonymous internal denial; with `ACCESS_CLIENT_ID`/`ACCESS_CLIENT_SECRET` in the
environment it also checks authenticated reads. It never prints bodies or credentials.
Use `node scripts/smoke-api.mjs production` for production: it requires that
environment's Access pair, verifies authenticated reads and ensures staging
rejects the production token. Both `workers.dev` and version URLs are explicitly
disabled in Wrangler to avoid alternate unprotected entry points.

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
  in the GitHub `staging`/`production` environments. Production also requires
  `ACCESS_CLIENT_ID`/`ACCESS_CLIENT_SECRET` in its environment for smoke tests.
  `master` pushes deploy staging (migrate → deploy → smoke).
  Production is deployed only by manual dispatch, which
  should be protected by required reviewers on the `production` environment.
