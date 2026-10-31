import { coreText, formatCoreText } from './core'

// API-only messages live in Core's Japanese and English catalogs.
export function apiText(language = 'ja_jp') {
  const text = (key: string) => coreText(language, `eewbot.scmd.${key}`)
  return {
    auth: {
      commandsDisabled: text('error.commandsdisabled'),
      invalidContext: text('error.invalidcontext'),
      manageGuildRequired: text('error.manageguildrequired'),
    },
    start: {
      settings: text('setup.error.start'),
      testmessage: text('testmessage.error.start'),
      quakeinfo: text('quakeinfo.error.start'),
    },
    unsupported: text('error.unsupported'),
    settings: {
      invalidValue: text('setup.error.invalidvalue'),
      targetMismatch: text('setup.error.targetmismatch'),
      failed: text('setup.error.unknown'),
    },
    discord: {
      rateLimited: text('error.ratelimit'),
      forbidden: text('error.missingperms'),
      notFound: text('error.notfound'),
      unavailable: text('error.unavailable'),
      unsupportedChannel: text('error.unsupportedchannel'),
      botPermissionsRequired: text('error.botpermissionsrequired'),
    },
    invite: (url: string) => formatCoreText(language, 'eewbot.scmd.invite.reply', url),
  }
}
