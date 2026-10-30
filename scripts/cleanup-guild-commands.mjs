import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { globalCommands, isSnowflake, verifiedDiscord, verifyGlobalCommands } from './register-global-commands.mjs'

export async function cleanupGuildCommands(config, credentials, options, request = fetch) {
  // Legacy guild cleanup is a staging migration operation only.
  if (options.environment !== 'staging' || !isSnowflake(options.guildId)) throw new Error('Select staging and a valid migration-only Guild ID.')
  if (options.deleteLegacy && !options.globalClientVerified && !options.deleteBeforeClientVerification) {
    throw new Error('Confirm Global Commands in the Discord client, or explicitly request deletion before client verification.')
  }
  const { plan, discord } = await verifiedDiscord(config, credentials, options, request)
  const path = `/applications/${plan.applicationId}/guilds/${options.guildId}/commands`
  const list = await discord(path)
  if (!Array.isArray(list) || list.some(c => !isSnowflake(c?.id) || typeof c.name !== 'string' || !Number.isInteger(c.type))) {
    throw new Error('Invalid Guild Command list.')
  }
  const owned = c => globalCommands.some(d => d.name === c.name && d.type === c.type)
  const candidates = list.filter(owned).map(c => ({ id: c.id, name: c.name, type: c.type }))
  // The preview is emitted before any deletion, including if verification/deletion later fails.
  options.onPreview?.(candidates)
  if (!options.deleteLegacy) return { candidates, deleted: [] }
  verifyGlobalCommands(await discord(`/applications/${plan.applicationId}/commands`))
  for (const c of candidates) await discord(path + '/' + c.id, 'DELETE')
  const remaining = await discord(path)
  if (!Array.isArray(remaining) || remaining.some(owned)
    || list.filter(c => !owned(c)).some(c => !remaining.some(r => r.id === c.id && r.name === c.name && r.type === c.type))) {
    throw new Error('Guild Command cleanup verification failed.')
  }
  return { candidates, deleted: candidates, unrelatedRemaining: list.filter(c => !owned(c)).length,
    clientVerified: options.globalClientVerified === true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = {}
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i]
      if (arg === '--env') options.environment = process.argv[++i]
      else if (arg === '--guild-id') options.guildId = process.argv[++i]
      else if (arg === '--delete-legacy-guild-commands') options.deleteLegacy = true
      else if (arg === '--confirm-global-client-verified') options.globalClientVerified = true
      else if (arg === '--delete-before-client-verification') options.deleteBeforeClientVerification = true
      else throw new Error('Unknown migration option.')
    }
    options.onPreview = candidates => console.log(JSON.stringify({ candidates }, null, 2))
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
    console.log(JSON.stringify(await cleanupGuildCommands(config, process.env, options), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
