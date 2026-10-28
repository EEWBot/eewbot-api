import { D1DestinationStore } from '../db/d1-destination-store'
import type { Bindings } from '../env'
import { displayLanguage, type LanguageCode } from '../i18n/languages'
import { helpText } from '../i18n/help'
import type { Interaction } from './types'

const unavailable: Record<LanguageCode, string> = {
  ja_jp: 'ステージングでは未対応です。',
  en_us: 'Not available in staging.',
  zh_tw: '測試環境尚不支援。',
  ko_hanja: '스테이징에서는 아직 支援하지 않습니다.',
  ko_kp: '시험환경에서는 아직 지원하지 않습니다.',
}

export function isInfoInteraction(i: Interaction): boolean {
  return i.type === 2 && (i.data?.name === 'help' || i.data?.name === 'invite')
}

export function helpEmbed(language: string) {
  const code = displayLanguage(language).code
  const field = (name: string, value: string) => ({ name, value, inline: false })
  return {
    title: helpText(code, 'title'), description: helpText(code, 'desc'), color: 7506394,
    fields: [
      field('/setup', helpText(code, 'setup')),
      field('/quakeinfo', `${helpText(code, 'quakeinfo')}\n**${unavailable[code]}**`),
      field('/invite', helpText(code, 'invite')),
      field('/testmessage', helpText(code, 'testmessage')),
      field('/lang', helpText(code, 'lang')),
      field('/unregister', helpText(code, 'unregister')),
      field('/help', helpText(code, 'help')),
      field(helpText(code, 'linksName'), helpText(code, 'links')),
      field(helpText(code, 'legalName'), helpText(code, 'legal')),
    ],
  }
}

export async function infoResponse(i: Interaction, env: Bindings) {
  if (i.data?.name === 'invite') {
    const url = `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_APPLICATION_ID}&permissions=275414830144&scope=bot%20applications.commands`
    return { type: 4, data: { content: `EEWBot Devのテスト用招待URL: ${url}`, flags: 64, allowed_mentions: { parse: [] } } }
  }
  let language = 'ja_jp'
  try {
    if (env.DB) {
      // Bound the read so the initial public response meets Discord's deadline.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const destination = await Promise.race([
          new D1DestinationStore(env.DB).getDestination(i.channel_id!),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1500) }),
        ])
        if (destination && destination.guildId === i.guild_id) language = displayLanguage(destination.lang).code
      } finally { clearTimeout(timer) }
    }
  } catch { /* Storage failures fall back to Japanese without exposing diagnostics. */ }
  return { type: 4, data: { embeds: [helpEmbed(language)], allowed_mentions: { parse: [] } } }
}
