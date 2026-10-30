# EEWBot API

Hono + Cloudflare Workers implementation of EEWBot's future HTTP API.

This phase adds a **Cloudflare Access authenticated internal config API** and a
**cleanup writer** using the same Access application/AUD/token over the existing D1 destination storage.
Verified staging Discord settings interactions also access D1 directly.
It is not wired to the production EEWBot or its Discord Application.
The existing Java bot continues to receive Interactions through Gateway.

## Implemented

- `GET /health`: minimal health check
- `POST /interactions`: Discord Ed25519 verification over **raw request bytes**
- Signed Discord PING (type 1) → PONG (type 1)
- Diagnostic `/ping` command → ephemeral response with a button
- Diagnostic button `test:ping` → ephemeral response
- Global Guild Install commands with common authorization in any installed guild; `/setup`, `/unregister` and `/lang` use revisioned D1 writes (currently deployed only to staging)
- Unknown command/component → ephemeral not-implemented response
- Autocomplete → empty choices
- Local tests and GitHub Actions CI, optional staging deployment workflow
- D1 destination schema, atomic revisioned CRUD and coherent snapshots (internal only)
- `GET /internal/v1/meta`, `/internal/v1/config/revision`, `/internal/v1/config/snapshot`
  with native Access context/AUD checks and `Cache-Control: no-store`
- `GET /internal/v1/cleanup/meta` and cleanup-only POST operations for guilds,
  destinations, guarded webhooks and webhook IDs, using the common internal Access control

The public Interactions URL is intentionally **unversioned**: `/interactions`.
The config API for EEWBot Core uses versioned routes under `/internal/v1/...`.
See [the internal API contract](docs/internal-api.md) for JSON types, errors and
the Java reader integration contract and [cleanup writer setup/contracts](docs/cleanup-api.md).

See [Global Command migration and common Guild authorization](docs/discord-global-commands.md) for registration, legacy cleanup, verification, production handoff and rollback.

## Environments

| | Staging | Production |
| --- | --- | --- |
| Public URL | `https://api-staging.eewbot.net` | `https://api.eewbot.net` |
| Worker | `eewbot-api-staging` | `eewbot-api-production` |
| Discord Application | Separate test Application | Existing EEWBot (future migration) |
| D1 | `eewbot-staging` (binding `DB`) | None in this phase |
| Deployment | Automatic on `master` once enabled | Approved, verified release (future workflow) |

Both environments use the same source with independent Workers and secrets.
Wrangler appends the environment name to `eewbot-api`; bindings such as D1 must
be configured separately per environment when added. See the
[Wrangler environments documentation](https://developers.cloudflare.com/workers/wrangler/environments/).
Custom Domains are configured in `wrangler.jsonc`, and `workers.dev` is disabled.

Every deployment must explicitly select `--env staging` or `--env production`.
There is no generic `npm run deploy` script.

```sh
npx wrangler deploy --env staging
# Future production deployment, only after release verification and approval:
npx wrangler deploy --env production
```

The equivalent npm scripts are `npm run deploy:staging` and
`npm run deploy:production`. Initially deploy **staging only**. Production's
Discord Application continues receiving interactions through Gateway.
The eventual production HTTP endpoint is `https://api.eewbot.net/interactions`.
Only staging has a D1 binding. See [D1 storage and migrations](docs/d1-storage.md)
for setup, the actual database ID requirement, schema and operation contracts.

## Local setup

Use Node.js 24 (or a supported Node.js version) and npm.

```sh
npm ci
cp .dev.vars.example .dev.vars.staging
# Edit .dev.vars.staging and set DISCORD_PUBLIC_KEY to the public key of your TEST Discord Application.
npm run dev
```

```sh
curl http://localhost:8787/health
```

Requests to `/interactions` must be signed. An unsigned curl PING intentionally returns HTTP 401.
The Discord Developer Portal checks the PING response and deliberately sends invalid
signatures; the Worker must reject invalid signatures even for PING.

```sh
npm run check
npm test
npm run build
```

Tests generate temporary Ed25519 keys and do not require real Discord or Cloudflare credentials.
All tests run in the Workers runtime using `@cloudflare/vitest-plugin`; the D1 tests
apply the real SQL migrations to local D1, with remote bindings explicitly disabled.
`npm test` includes Interactions, D1 and internal API tests; `npm run test:d1` selects D1 only.
`npm run build` performs deployment dry runs for both environments without publishing.

Internal tests inject a trusted, synthetic Access context into the official test
ExecutionContext, separately from HTTP headers. They apply actual migrations to
local D1 and need no real Service Token, Access application or JWT. Ordinary
`wrangler dev` has no authenticated Access context and refuses internal reads.
For manual local simulation only, use Cloudflare's documented `access.dev` block
in a separate ignored Wrangler config, set its `aud` and local `ACCESS_AUD` to the
same synthetic value, and retain the staging D1 binding. Never deploy that config.

## Staging internal API / Cloudflare Access setup

Protect **only** `api-staging.eewbot.net/internal` and
`api-staging.eewbot.net/internal/*`. The wildcard excludes its parent path.
Keep `/health` and `/interactions` public. Do not enable Worker-level,
hostname-wide or account-wide protection. Do not change production Access,
production bindings, the production Discord Application or Java credentials.

The existing Wrangler OAuth session can read Access configuration, but creating
an application returned Cloudflare HTTP 403 (`auth.forbidden`) on 2026-10-25.
At that check there was no staging internal Access application or Service Token,
and the staging Worker had no `ACCESS_AUD`. On 2026-10-26, the operator supplied
the real application AUD, which was installed as the staging-only `ACCESS_AUD`
secret binding. Public health (200), unsigned Interactions (401), and internal
denial smoke tests passed; anonymous internal requests were rejected at the edge
with HTTP 401 and cache prevention headers. The current API credentials could
not independently verify the application's Service Auth policy. Authenticated
reads were then verified on 2026-10-26 using operator-supplied Service Token
credentials loaded only into the verification process. All three endpoints
returned HTTP 200 with `Cache-Control: no-store`; staging had revision 0 and an
empty snapshot. POST/PUT/PATCH/DELETE/HEAD/OPTIONS returned 405 without changing
the revision, and a real client ID with an invalid secret returned 401. Neither
credentials nor snapshot bodies were logged or committed. No placeholder AUD or
production AUD is configured. If `ACCESS_AUD` is removed, the Worker fails closed
with HTTP 503 (`access_not_configured`).

An account administrator can complete these Dashboard steps:

1. In Cloudflare Zero Trust, open **Access controls > Service credentials >
   Service Tokens** and use the existing internal Core token (historically named
   `EEWBot Core staging read-only`). With the current common Access specification,
   this token authorizes both reads and cleanup writes; do not create another token.
   Choose an expiry and arrange rotation. Save its Client ID and one-time Client
   Secret in a secret manager. Never put either in Git, config.json or Actions logs.
2. Open **Access controls > Applications > Add an application > Self-hosted**.
   Name it `EEWBot staging internal read-only`. Add both public hostname/path
   destinations: `api-staging.eewbot.net/internal` and
   `api-staging.eewbot.net/internal/*`. Keep them in the same application/AUD.
   Do not add a destination without the internal path.
3. Add one **Service Auth** policy. Its **Include > Service Token** selector must
   contain only the dedicated token from step 1. Do not select all tokens,
   Everyone, Bypass, an interactive Allow policy or permissive CORS options.
4. Copy the application's real **Application Audience (AUD) Tag**. Store that
   exact value on the staging Worker (AUD is not a credential, but a secret
   binding keeps it outside tracked config and preserves it across deployments):

   ```sh
   npx wrangler secret put ACCESS_AUD --env staging
   # At the prompt, paste the real AUD from the application, never a placeholder.
   ```

   Do not set this binding in production. If using an API token instead of the
   Dashboard, it needs account-scoped `Access: Apps and Policies Write` and
   `Access: Service Tokens Write`; the Worker binding also needs Workers edit.
5. Run CI checks, staging D1 migrations, staging Worker deployment, then smoke
   tests, in that order. Do not deploy production:

   ```sh
   npm ci
   npm run check
   npm test
   npm run build
   npm run db:migrate:staging
   npm run deploy:staging
   node scripts/smoke-staging.mjs
   ```

The smoke script verifies public health, unsigned Interaction rejection, anonymous
internal denial (including `/internal` and unknown paths), invalid token/header
rejection, and absence of configuration in denied responses. Access can reject
before the Worker, so its redirects/errors are distinguished from Worker JSON.
To also check authenticated meta, revision and snapshot, securely inject
`ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` into the process environment and run
the same smoke script. It never prints credentials, JWTs or snapshot contents.
No credentials are required for CI; authenticated reads are skipped if absent.

When testing an unmerged PR branch on staging, a later `master` push will replace
that deployment with the `master` version. Keep the branch current, rerun checks
before redeploying it, and perform authenticated smoke tests against the deployed
API. Persistent rollout follows review and merge of the PR; do not disable the
existing automatic staging workflow to preserve a temporary branch deployment.

After setup, verify these cases without printing response bodies or using verbose
HTTP tracing: health 200; unsigned Interactions 401; valid token internal reads
200 with `no-store`; missing, invalid and expired/revoked tokens denied. An empty
staging DB returns revision 0 and an empty snapshot. Do not clear staging data to
force that state. Revoke a disposable test token to test revocation; keep the Core
token intact. Local tests separately prove Worker rejection when Access is
bypassed and when the context AUD belongs to a different application. A real
signed Discord request can additionally be exercised from the test Discord app.

Official references: [native Workers Access context and local simulation](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
[path matching](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
[Service Auth policy](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).

## Test Discord Application only

Phase 1 `/setup` and `/unregister`, their staging-only configuration, permissions,
webhook lifecycle and Java Core HTTP integration are documented in
[Discord setup interactions](docs/discord-setup.md). Settings commands default to
disabled and require the environment's Bot Token and pinned Application ID. Guild IDs
come from verified interactions; no fixed Guild is configured.
`/lang` adds five-language selection and atomic guild-wide application; see
[language interactions and verification](docs/discord-lang.md).

1. Create a **separate** Discord Application and copy its **Public Key**.
2. Set `DISCORD_PUBLIC_KEY` in `.dev.vars.staging` for local development.
3. Deploy this Worker to staging with `npm run deploy:staging`.
   Before the first deploy, authenticate with `npx wrangler login`.
   The Cloudflare account must manage the `eewbot.net` zone for the Custom Domain.
4. Set the staging Worker's key with `npx wrangler secret put DISCORD_PUBLIC_KEY --env staging`.
   Secrets must be set independently for each environment.
   Do not commit `.dev.vars*`, API tokens, or Bot tokens.
5. Configure that **test** Application's Interactions Endpoint URL to
   `https://api-staging.eewbot.net/interactions`.
6. Register all eight commands as Global Commands on the **test** Application.
   With the staging `DISCORD_STAGING_BOT_TOKEN` (or legacy `DISCORD_BOT_TOKEN`)
   supplied through the environment, run
   `npm run register:global-commands -- --env staging --dry-run`, then
   `npm run register:global-commands -- --env staging --apply`.
7. Invoke `/ping` and press the returned button to test both interaction types.

Do **not** configure the production EEWBot Application's HTTP endpoint yet.
For a single Discord Application, Gateway and HTTP Interactions are mutually exclusive.
The legacy Java bot must continue handling production interactions until every production
command/component has been migrated and verified.

## CI / CD

PRs and pushes to `master` install the committed lockfile with `npm ci`, then run
type checking, tests and Wrangler dry runs for both environments.
CI also checks out a pinned public Java Core revision, builds its shadowJar, and
runs `npm run test:java` against synthetic signed interactions and local D1.
It needs no Discord/Cloudflare credentials or Gateway login. Staging deployment
is **disabled by default**. To enable automatic staging deployment after testing:

- Configure the GitHub `staging` environment. Add Actions secrets
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in that environment.
- Set repository Actions variable `CLOUDFLARE_DEPLOY_ENABLED=true`.
- Add `DISCORD_PUBLIC_KEY` to the staging Worker with
  `npx wrangler secret put DISCORD_PUBLIC_KEY --env staging`, using the **test** Application's key.
- Ensure the staging Actions token can edit D1 and the Worker, and configure the actual
  `eewbot-staging` database ID in `wrangler.jsonc` before enabling deployment.
- Pushes to `master` apply staging D1 migrations, deploy with `--env staging`, then
  smoke-test health, unsigned Interaction rejection and internal denial after all checks pass. Manual dispatch
  is restricted to `master` and requires the same variable and credentials.

Migration failure stops deployment. All remote D1 commands explicitly select staging.
Remote migration/deployment scripts reject a missing database ID, preventing accidental
automatic provisioning. Migration status lives in `d1_migrations`; application data
import history lives separately in `data_migrations`.

This workflow never deploys production. A production release workflow with approval
is a later step, alongside migration and verification of the production interactions.
Production deployment and production Discord configuration changes are outside this PR.

## Roadmap

- Add a remote `DestinationConfigSource` to EEWBot Core.
- Securely provision the dedicated Access token to Core, with rotation and expiry monitoring.
- Port all production slash commands, component handlers and authorization logic.
- Only then switch the production Discord Interactions Endpoint URL.

Discord snowflake IDs must remain **strings** in HTTP JSON and any future
TypeScript/D1 implementation; do not pass them through JavaScript `Number`.
