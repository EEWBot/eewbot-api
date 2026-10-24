# EEWBot API

Hono + Cloudflare Workers implementation of EEWBot's future HTTP API.

This initial phase is an **isolated Discord Interactions proof of concept**. It does not
use D1 and is not wired to the production EEWBot or its Discord Application.
The existing Java bot continues to receive Interactions through Gateway.

## Implemented

- `GET /health`: minimal health check
- `POST /interactions`: Discord Ed25519 verification over **raw request bytes**
- Signed Discord PING (type 1) → PONG (type 1)
- Test-only `/ping` command → ephemeral response with a button
- Test-only button `test:ping` → ephemeral response
- Unknown command/component → ephemeral not-implemented response
- Autocomplete → empty choices
- Local tests and GitHub Actions CI, optional staging deployment workflow

The public Interactions URL is intentionally **unversioned**: `/interactions`.
Future APIs for EEWBot Core will use versioned routes such as `/internal/v1/...`.

## Environments

| | Staging | Production |
| --- | --- | --- |
| Public URL | `https://api-staging.eewbot.net` | `https://api.eewbot.net` |
| Worker | `eewbot-api-staging` | `eewbot-api-production` |
| Discord Application | Separate test Application | Existing EEWBot (future migration) |
| D1 (future) | `eewbot-staging` | `eewbot-production` |
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
No D1 databases or bindings are created in this phase.

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
`npm run build` performs deployment dry runs for both environments without publishing.

## Test Discord Application only

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
6. Register `/ping` as a guild-scoped application command on the **test** Application.
   With `DISCORD_APPLICATION_ID`, `DISCORD_TEST_GUILD_ID`, and `DISCORD_BOT_TOKEN`
   set in your shell (for the test app only), run `npm run register:test-command`.
7. Invoke `/ping` and press the returned button to test both interaction types.

Do **not** configure the production EEWBot Application's HTTP endpoint yet.
For a single Discord Application, Gateway and HTTP Interactions are mutually exclusive.
The legacy Java bot must continue handling production interactions until every production
command/component has been migrated and verified.

## CI / CD

PRs and pushes to `master` install the committed lockfile with `npm ci`, then run
type checking, tests and Wrangler dry runs for both environments. Staging deployment
is **disabled by default**. To enable automatic staging deployment after testing:

- Configure the GitHub `staging` environment. Add Actions secrets
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in that environment.
- Set repository Actions variable `CLOUDFLARE_DEPLOY_ENABLED=true`.
- Add `DISCORD_PUBLIC_KEY` to the staging Worker with
  `npx wrangler secret put DISCORD_PUBLIC_KEY --env staging`, using the **test** Application's key.
- Pushes to `master` deploy with `--env staging` after all checks pass. Manual dispatch
  is restricted to `master` and requires the same variable and credentials.

This workflow never deploys production. A production release workflow with approval
is a later step, alongside migration and verification of the production interactions.
No Cloudflare deployment or production Discord configuration change is performed by this PR.

## Roadmap

- Add D1 schema and migration tests as a separate change.
- Implement internal versioned config API and snapshot/revision endpoints.
- Add a remote `DestinationConfigSource` to EEWBot Core.
- Port all production slash commands, component handlers and authorization logic.
- Only then switch the production Discord Interactions Endpoint URL.

Discord snowflake IDs must remain **strings** in HTTP JSON and any future
TypeScript/D1 implementation; do not pass them through JavaScript `Number`.
