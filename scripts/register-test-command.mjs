// Register /ping on a TEST Discord Application and guild; never modify production commands.
const applicationId = process.env.DISCORD_APPLICATION_ID
const guildId = process.env.DISCORD_TEST_GUILD_ID
const botToken = process.env.DISCORD_BOT_TOKEN

if (![applicationId, guildId].every((id) => typeof id === 'string' && /^\d+$/.test(id)) || !botToken) {
  console.error('Set DISCORD_APPLICATION_ID, DISCORD_TEST_GUILD_ID and DISCORD_BOT_TOKEN for the TEST application.')
  process.exit(1)
}

const endpoint =
  'https://discord.com/api/v10/applications/' +
  encodeURIComponent(applicationId) +
  '/guilds/' +
  encodeURIComponent(guildId) +
  '/commands'
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    Authorization: 'Bot ' + botToken,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'ping',
    description: 'Test the EEWBot HTTP Interactions endpoint',
    type: 1,
  }),
})

if (!response.ok) {
  // Discord errors may include details, but never print a token.
  console.error('Discord command registration failed: HTTP ' + response.status)
  process.exit(1)
}
console.log('Registered /ping for the test guild.')
