import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const testCommands = [
  { name: 'ping', description: 'Test the EEWBot HTTP Interactions endpoint', type: 1 },
  { name: 'setup', description: '現在のチャンネルにBotが通知する情報を設定します。', type: 1, default_member_permissions: '32' },
  { name: 'unregister', description: 'このチャンネルの登録を解除します。', type: 1, default_member_permissions: '32' },
  { name: 'lang', description: 'チャンネルに言語を設定します。', type: 1, default_member_permissions: '32' },
  { name: 'help', description: 'Helpを表示します。', type: 1 },
  { name: 'invite', description: 'テスト用の招待URLを取得します。', type: 1 },
  { name: 'testmessage', description: 'Botからテストメッセージを送信し、現在のチャンネルで正常に動作するか確認します。', type: 1 },
  { name: 'quakeinfo', description: '最新の地震情報を取得します。', type: 1 },
]

/** Pin IDs to checked-in staging vars. Environment variables cannot redirect writes. */
export async function registerTestCommands(config, environment, request = fetch, testMessageOnly = false, quakeInfoOnly = false) {
  const staging = config.env?.staging?.vars
  const applicationId = staging?.DISCORD_APPLICATION_ID
  const guildId = staging?.DISCORD_TEST_GUILD_ID
  const token = environment.DISCORD_BOT_TOKEN
  if (![applicationId, guildId].every((id) => typeof id === 'string' && /^[1-9][0-9]{0,18}$/.test(id))
    || !token || (environment.DISCORD_APPLICATION_ID && environment.DISCORD_APPLICATION_ID !== applicationId)
    || (environment.DISCORD_TEST_GUILD_ID && environment.DISCORD_TEST_GUILD_ID !== guildId)) {
    throw new Error('Configure the pinned TEST application/guild in staging vars and supply its bot token.')
  }
  async function discord(path, method = 'GET', body) {
    try {
      const response = await request('https://discord.com/api/v10' + path, {
        method, redirect: 'manual', signal: AbortSignal.timeout(5000),
        headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!response.ok) throw new Error()
      return await response.json()
    } catch {
      // Discard errors/response bodies, which may contain credentials.
      throw new Error('Discord command registration failed; check the TEST bot configuration and rate limits.')
    }
  }
  const application = await discord('/oauth2/applications/@me')
  if (application.id !== applicationId) throw new Error('Bot token does not belong to the pinned TEST application.')
  for (const command of testCommands) {
    if (testMessageOnly && command.name !== 'testmessage') continue
    if (quakeInfoOnly && command.name !== 'quakeinfo') continue
    // Individual guild upserts preserve every unrelated and global command.
    await discord(`/applications/${applicationId}/guilds/${guildId}/commands`, 'POST', command)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
    const testMessageOnly = process.argv.includes('--testmessage-only')
    const quakeInfoOnly = process.argv.includes('--quakeinfo-only')
    await registerTestCommands(config, process.env, fetch, testMessageOnly, quakeInfoOnly)
    console.log(testMessageOnly ? 'Registered /testmessage for the pinned test guild.'
      : quakeInfoOnly ? 'Registered /quakeinfo for the pinned test guild.'
      : 'Registered /ping, /setup, /unregister, /lang, /help, /invite, /testmessage and /quakeinfo for the pinned test guild.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
