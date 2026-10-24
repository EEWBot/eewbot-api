import { InteractionResponseType, InteractionType, verifyKey } from 'discord-interactions'
import { Hono } from 'hono'

type Bindings = {
  DISCORD_PUBLIC_KEY?: string
}

type Interaction = {
  type: number
  data?: {
    name?: unknown
    custom_id?: unknown
  }
}

const MAX_SIGNATURE_AGE_SECONDS = 5 * 60
const EPHEMERAL = 1 << 6

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.json({ status: 'ok' }))

// This public route is Discord's Interactions Endpoint URL, not a general-purpose API.
// All requests, including PING, must be verified before parsing or processing JSON.
app.post('/interactions', async (c) => {
  const publicKey = c.env.DISCORD_PUBLIC_KEY
  if (!publicKey) {
    return c.text('Discord application public key is not configured', 503)
  }

  const signature = c.req.header('X-Signature-Ed25519') ?? ''
  const timestamp = c.req.header('X-Signature-Timestamp') ?? ''
  const issuedAt = Number(timestamp)
  if (
    !/^[0-9a-fA-F]{128}$/.test(signature) ||
    !/^\d{10,}$/.test(timestamp) ||
    !Number.isSafeInteger(issuedAt) ||
    Math.abs(Date.now() / 1000 - issuedAt) > MAX_SIGNATURE_AGE_SECONDS
  ) {
    return c.text('Invalid Discord signature', 401)
  }

  // Do not use c.req.json() before verification: the signature covers the raw body.
  const rawBody = new Uint8Array(await c.req.raw.arrayBuffer())
  if (!(await verifyKey(rawBody, signature, timestamp, publicKey))) {
    return c.text('Invalid Discord signature', 401)
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody))
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    typeof (payload as Interaction).type !== 'number'
  ) {
    return c.json({ error: 'invalid_interaction' }, 400)
  }

  const interaction = payload as Interaction
  if (interaction.type === InteractionType.PING) {
    return c.json({ type: InteractionResponseType.PONG })
  }

  // These handlers are intentionally for a TEST Discord Application only.
  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === 'ping') {
    return c.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: 'Pong! This is the EEWBot API HTTP Interactions test.',
        flags: EPHEMERAL,
        allowed_mentions: { parse: [] },
        components: [
          {
            type: 1,
            components: [{ type: 2, style: 1, label: 'Test button', custom_id: 'test:ping' }],
          },
        ],
      },
    })
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT && interaction.data?.custom_id === 'test:ping') {
    return c.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: 'Button interaction received.',
        flags: EPHEMERAL,
        allowed_mentions: { parse: [] },
      },
    })
  }

  // Autocomplete requires a distinct response type.
  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    return c.json({ type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } })
  }

  if (
    interaction.type === InteractionType.APPLICATION_COMMAND ||
    interaction.type === InteractionType.MESSAGE_COMPONENT ||
    interaction.type === InteractionType.MODAL_SUBMIT
  ) {
    return c.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: 'This interaction has not been implemented in the test API.',
        flags: EPHEMERAL,
        allowed_mentions: { parse: [] },
      },
    })
  }

  return c.json({ error: 'unsupported_interaction_type' }, 400)
})

export default app
