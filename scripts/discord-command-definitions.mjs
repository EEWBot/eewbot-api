import descriptions from '../src/i18n/command-descriptions.json' with { type: 'json' }

// The migration and registrar share the exact owned names and command types.
export const globalCommands = [
  { name: 'setup', default_member_permissions: '32' },
  { name: 'unregister', default_member_permissions: '32' },
  { name: 'lang', default_member_permissions: '32' },
  { name: 'help' },
  { name: 'invite' },
  { name: 'testmessage' },
  { name: 'quakeinfo' },
].map((command) => {
  const key = `eewbot.scmd.${command.name}.description`
  const japanese = descriptions.ja_jp[key]
  const english = descriptions.en_us[key]
  const traditionalChinese = descriptions.zh_tw[key]
  const localizations = {
    ja: japanese,
    'en-US': english,
    'en-GB': english,
    ...(traditionalChinese === undefined ? {} : { 'zh-TW': traditionalChinese }),
  }
  for (const description of Object.values(localizations)) {
    if (typeof description !== 'string' || description.length < 1 || description.length > 100)
      throw new Error(`Invalid command description: ${key}`)
  }
  return {
    type: 1,
    integration_types: [0],
    contexts: [0, 1],
    // Explicit null clears a stale permission restriction during an upsert.
    default_member_permissions: null,
    ...command,
    description: english,
    description_localizations: localizations,
  }
})

// Previously registered commands that a full registration deletes.
export const retiredGlobalCommands = ['ping']
