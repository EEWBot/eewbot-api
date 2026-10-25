const base = 'https://api-staging.eewbot.net'
const health = await fetch(`${base}/health`)
if (health.status !== 200 || (await health.json()).status !== 'ok') {
  throw new Error('Staging health smoke test failed')
}
const interaction = await fetch(`${base}/interactions`, { method: 'POST', body: '{"type":1}' })
if (interaction.status !== 401) throw new Error('Staging must reject unsigned Discord Interactions')
console.log('Staging health and unsigned Interaction smoke tests passed')
