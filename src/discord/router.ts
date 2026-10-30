import { InteractionType } from 'discord-interactions'
import type { Bindings } from '../env'
import { apiText } from '../i18n/api'
import { errorName, log } from '../log'
import { type Authorization, authorizeAdmin, authorizeMember } from './authorize'
import { infoResponse, isInfoInteraction } from './info-command'
import { isLanguageInteraction, processLanguage } from './language-command'
import { isQuakeInfoInteraction, processQuakeInfo } from './quakeinfo-command'
import { deferred, deferredUpdate, emptyAutocomplete, ephemeral, type InteractionResponse, pong } from './responses'
import { isSettingsInteraction, processSettings } from './settings-command'
import { isTestMessageInteraction, processTestMessage } from './testmessage-command'
import type { GuildInteraction, Interaction } from './types'

const text = apiText()

type Background = { waitUntil(promise: Promise<unknown>): void }

type HandlerBase = {
  name: string
  matches: (i: Interaction) => boolean
  authorize: (i: Interaction, env: Bindings) => Authorization
}

/** Answers within Discord's 3-second deadline. */
type ImmediateHandler = HandlerBase & {
  respond: (i: GuildInteraction, env: Bindings) => Promise<InteractionResponse>
}

/** Acknowledges at once, then edits @original from waitUntil(). */
type DeferredHandler = HandlerBase & {
  ack: (i: GuildInteraction) => InteractionResponse
  process: (i: GuildInteraction, env: Bindings) => Promise<void>
  startFailure: string
}

type Handler = ImmediateHandler | DeferredHandler

/** Commands edit an ephemeral "thinking" reply; components edit their own menu message in place. */
const ephemeralOrUpdate = (i: GuildInteraction) =>
  i.type === InteractionType.MESSAGE_COMPONENT ? deferredUpdate() : deferred({ ephemeral: true })

export const handlers: readonly Handler[] = [
  {
    name: 'quakeinfo',
    matches: isQuakeInfoInteraction,
    authorize: authorizeMember,
    // Public, so the posted information is visible to the channel (including errors).
    ack: () => deferred(),
    process: processQuakeInfo,
    startFailure: text.start.quakeinfo,
  },
  {
    name: 'testmessage',
    matches: isTestMessageInteraction,
    authorize: authorizeMember,
    ack: () => deferred({ ephemeral: true }),
    process: processTestMessage,
    startFailure: text.start.testmessage,
  },
  {
    name: 'settings',
    matches: isSettingsInteraction,
    authorize: authorizeAdmin,
    ack: ephemeralOrUpdate,
    process: processSettings,
    startFailure: text.start.settings,
  },
  {
    name: 'lang',
    matches: isLanguageInteraction,
    authorize: authorizeAdmin,
    ack: ephemeralOrUpdate,
    process: processLanguage,
    startFailure: text.start.settings,
  },
  {
    name: 'info',
    matches: isInfoInteraction,
    authorize: authorizeMember,
    respond: infoResponse,
  },
]

/**
 * Routes a verified interaction. Background work is scheduled before the ACK is
 * returned. `executionContext` may throw when the runtime provides none.
 */
export async function dispatch(
  i: Interaction,
  env: Bindings,
  executionContext: () => Background,
): Promise<InteractionResponse | null> {
  switch (i.type) {
    case InteractionType.PING:
      return pong()
    case InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE:
      return emptyAutocomplete()
    case InteractionType.APPLICATION_COMMAND:
    case InteractionType.MESSAGE_COMPONENT:
    case InteractionType.MODAL_SUBMIT:
      break
    default:
      return null
  }

  const handler = handlers.find((h) => h.matches(i))
  if (!handler) return ephemeral(text.unsupported)

  const auth = handler.authorize(i, env)
  if (!auth.ok) return ephemeral(auth.message)
  const interaction = auth.interaction

  if ('respond' in handler) return handler.respond(interaction, env)
  // Resolve the context before starting any work, so nothing runs unscheduled.
  let ctx: Background
  try {
    ctx = executionContext()
  } catch {
    return ephemeral(handler.startFailure)
  }
  ctx.waitUntil(
    handler.process(interaction, env).catch((error: unknown) => {
      // process() reports its own failures to the user; this is a last-resort guard.
      log.error('discord_background_failed', { handler: handler.name, error: errorName(error) })
    }),
  )
  return handler.ack(interaction)
}
