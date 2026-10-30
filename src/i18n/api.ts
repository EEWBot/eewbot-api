import { coreText, formatCoreText } from './core'

// API-only messages live in Core's Japanese and English catalogs.
export function apiText(language = 'ja_jp') {
  const text = (key: string) => coreText(language, `eewbot.scmd.api.${key}`)
  return {
    auth: {
      commandsDisabled: text('auth.commandsdisabled'),
      invalidContext: text('auth.invalidcontext'),
      manageGuildRequired: text('auth.manageguildrequired'),
    },
    start: {
      settings: text('start.settings'),
      testmessage: text('start.testmessage'),
      quakeinfo: text('start.quakeinfo'),
    },
    unsupported: text('unsupported'),
    settings: {
      invalidValue: text('settings.invalidvalue'),
      targetMismatch: text('settings.targetmismatch'),
      failed: text('settings.failed'),
    },
    discord: {
      rateLimited: text('discord.ratelimited'),
      forbidden: text('discord.forbidden'),
      notFound: text('discord.notfound'),
      unavailable: text('discord.unavailable'),
      unsupportedChannel: text('discord.unsupportedchannel'),
      botPermissionsRequired: text('discord.botpermissionsrequired'),
    },
    invite: (url: string) => formatCoreText(language, 'eewbot.scmd.api.invite.reply', url),
  }
}
