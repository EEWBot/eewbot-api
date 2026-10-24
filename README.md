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
- Local tests and GitHub Actions CI, optional Cloudflare deployment workflow

The public Interactions URL is intentionally **unversioned**: `/interactions`.
Future APIs for EEWBot Core will use versioned routes such as `/internal/v1/...`.

## Local setup

Use Node.js 24 (or a supported Node.js version) and npm.

```sh
npm install --package-lock=false
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set DISCORD_PUBLIC_KEY to the public key of your TEST Discord Application.
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

## Test Discord Application only

1. Create a **separate** Discord Application and copy its **Public Key**.
2. Set `DISCORD_PUBLIC_KEY` in `.dev.vars` for local development.
3. Deploy this Worker to a disposable test environment with `npm run deploy`.
   Before the first deploy, authenticate with `npx wrangler login`.
4. Set the deployed Worker's key with `npx wrangler secret put DISCORD_PUBLIC_KEY`.
   Do not commit `.dev.vars`, API tokens, or Bot tokens.
5. Configure that **test** Application's Interactions Endpoint URL to
   `https://<your-worker-host>/interactions`.
6. Register `/ping` as a guild-scoped application command on the **test** Application.
   With `DISCORD_APPLICATION_ID`, `DISCORD_TEST_GUILD_ID`, and `DISCORD_BOT_TOKEN`
   set in your shell (for the test app only), run `npm run register:test-command`.
7. Invoke `/ping` and press the returned button to test both interaction types.

Do **not** configure the production EEWBot Application's HTTP endpoint yet.
For a single Discord Application, Gateway and HTTP Interactions are mutually exclusive.
The legacy Java bot must continue handling production interactions until every production
command/component has been migrated and verified.

## CI / CD

PRs and pushes to `master` run tests, type checking and a Wrangler dry run. The initial scaffold has no lockfile; generate and commit `package-lock.json` after the first successful dependency installation, then switch CI/CD to `npm ci`. Deployment
is **disabled by default**. To enable automatic deployment after testing:

- Add GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Set repository Actions variable `CLOUDFLARE_DEPLOY_ENABLED=true`.
- Add `DISCORD_PUBLIC_KEY` as a Cloudflare Worker secret for the **test** Application.
- Pushing to `master` will deploy when the repository variable is enabled. Manual dispatch is also available, but still requires that variable and both secrets.

Cloudflare deployment is not performed by this initial PR.

## Roadmap

- Add D1 schema and migration tests as a separate change.
- Implement internal versioned config API and snapshot/revision endpoints.
- Add a remote `DestinationConfigSource` to EEWBot Core.
- Port all production slash commands, component handlers and authorization logic.
- Only then switch the production Discord Interactions Endpoint URL.

Discord snowflake IDs must remain **strings** in HTTP JSON and any future
TypeScript/D1 implementation; do not pass them through JavaScript `Number`.
