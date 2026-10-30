import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { globalCommands, retiredGlobalCommands } from './discord-command-definitions.mjs'

export { globalCommands, retiredGlobalCommands }
export const isSnowflake = (value) => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)

/** IDs come only from the selected checked-in environment, never credential overrides. */
export function registrationPlan(config, options) {
  const { environment, commands } = options
  if (!['staging', 'production'].includes(environment))
    throw new Error('Select --env staging or --env production explicitly.')
  const applicationId = config.env?.[environment]?.vars?.DISCORD_APPLICATION_ID
  const other = config.env?.[environment === 'staging' ? 'production' : 'staging']?.vars?.DISCORD_APPLICATION_ID
  if (!isSnowflake(applicationId) || applicationId === other)
    throw new Error('Configure distinct Application IDs in the selected Wrangler environment before using a bot token.')
  if (
    commands &&
    (!Array.isArray(commands) ||
      !commands.length ||
      commands.some((name) => !globalCommands.some((c) => c.name === name)))
  ) {
    throw new Error('Select only known command names.')
  }
  return {
    environment,
    applicationId,
    requests: globalCommands
      .filter((c) => !commands || commands.includes(c.name))
      .map((body) => ({ method: 'POST', path: `/applications/${applicationId}/commands`, body })),
  }
}

export async function verifiedDiscord(config, credentials, options, request = fetch) {
  const plan = registrationPlan(config, options)
  if (plan.environment === 'production' && options.confirmProductionApplication !== plan.applicationId) {
    throw new Error('Production access requires --confirm-production-application with the configured Application ID.')
  }
  if (credentials.DISCORD_APPLICATION_ID && credentials.DISCORD_APPLICATION_ID !== plan.applicationId) {
    throw new Error('Credential Application ID differs from the selected environment.')
  }
  // A generic existing token is accepted only for staging. Production needs a separate explicit credential.
  const token =
    plan.environment === 'staging'
      ? (credentials.DISCORD_STAGING_BOT_TOKEN ?? credentials.DISCORD_BOT_TOKEN)
      : credentials.DISCORD_PRODUCTION_BOT_TOKEN
  if (typeof token !== 'string' || !token.trim()) throw new Error('Supply the bot token for the selected environment.')
  async function discord(path, method = 'GET', body) {
    let status = 0
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await request(`https://discord.com/api/v10${path}`, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        status = response.status
        if (status === 429 && attempt < 3) {
          const header = response.headers.get('Retry-After')
          const seconds = header === null ? (await response.json())?.retry_after : Number(header)
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error()
          // Only a definite 429 is retried. Transport failures and 5xx are reported.
          await new Promise((resolve) => setTimeout(resolve, Math.ceil(seconds * 1000)))
          continue
        }
        if (!response.ok) throw new Error()
        return status === 204 ? undefined : await response.json()
      }
    } catch {
      // Never propagate response bodies or transport errors containing credentials.
      throw new Error(`Discord command operation failed (HTTP ${status}); check configuration and rate limits.`)
    }
  }
  const application = await discord('/oauth2/applications/@me')
  if (application?.id !== plan.applicationId) throw new Error('Bot token does not belong to the selected Application.')
  return { plan, discord }
}

export function verifyGlobalCommands(commands, definitions = globalCommands) {
  if (!Array.isArray(commands)) throw new Error('Invalid Global Command list.')
  for (const definition of definitions) {
    const matches = commands.filter((c) => c.name === definition.name && c.type === definition.type)
    const c = matches[0]
    if (
      matches.length !== 1 ||
      !isSnowflake(c?.id) ||
      c.guild_id != null ||
      c.description !== definition.description ||
      (c.options?.length ?? 0) !== 0 ||
      JSON.stringify(c.integration_types) !== '[0]' ||
      JSON.stringify(c.contexts) !== '[0]' ||
      (c.default_member_permissions ?? null) !== definition.default_member_permissions
    ) {
      throw new Error(`Global Command verification failed for /${definition.name}`)
    }
  }
  return commands
    .filter((c) => definitions.some((d) => d.name === c.name && d.type === c.type))
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      integration_types: c.integration_types,
      contexts: c.contexts,
      default_member_permissions: c.default_member_permissions ?? null,
    }))
}

export async function registerGlobalCommands(config, credentials, options, request = fetch) {
  const plan = registrationPlan(config, options)
  // Dry runs neither inspect credentials nor make network requests, including for production.
  if (!options.apply) return plan
  const { discord } = await verifiedDiscord(config, credentials, options, request)
  for (const operation of plan.requests) await discord(operation.path, operation.method, operation.body)
  let registered = await discord(`/applications/${plan.applicationId}/commands`)
  // A full registration also removes retired commands (e.g. the old diagnostic /ping).
  const retired = options.commands ? [] : (registered ?? []).filter((c) => retiredGlobalCommands.includes(c.name))
  for (const command of retired) {
    if (!isSnowflake(command.id)) throw new Error('Invalid retired Global Command ID.')
    await discord(`/applications/${plan.applicationId}/commands/${command.id}`, 'DELETE')
  }
  if (retired.length) registered = await discord(`/applications/${plan.applicationId}/commands`)
  return {
    environment: plan.environment,
    applicationId: plan.applicationId,
    commands: verifyGlobalCommands(
      registered,
      plan.requests.map((r) => r.body),
    ),
  }
}

export function parseArguments(args) {
  const options = { apply: false }
  const commands = []
  let dryRun = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--env') options.environment = args[++index]
    else if (arg === '--command') commands.push(args[++index])
    else if (arg === '--testmessage-only' || arg === '--quakeinfo-only') commands.push(arg.slice(2, -5))
    else if (arg === '--confirm-production-application') options.confirmProductionApplication = args[++index]
    else throw new Error('Unknown registration option.')
  }
  if (commands.length) options.commands = commands
  if (dryRun && options.apply) throw new Error('Choose --dry-run or --apply, not both.')
  return options
}

export async function main(args = process.argv.slice(2)) {
  try {
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
    console.log(JSON.stringify(await registerGlobalCommands(config, process.env, parseArguments(args)), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
