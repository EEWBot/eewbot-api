import { coreText, formatCoreText } from './core'

// SeismicIntensity.toString()/getSimple(), in Java's numeric storage order.
export const INTENSITIES = ['不明', '1', '2', '3', '4', '5弱', '5強', '6弱', '6強', '7'] as const

export function setupOptionText(
  language: string,
  group: 'base' | 'modifier',
  flag: string,
  part: 'label' | 'desc',
): string {
  return coreText(language, `eewbot.scmd.setup.${group}.${flag.toLowerCase()}.${part}`)
}

export function setupReply(language: string, noWebhook: boolean): string {
  return (
    coreText(language, 'eewbot.scmd.setup.reply') +
    '\n' +
    coreText(language, 'eewbot.scmd.setup.legal') +
    (noWebhook ? `\n\n${coreText(language, 'eewbot.scmd.setup.permserror.managewebhooks')}` : '')
  )
}

export function setupFollowup(language: string, action: 'b' | 'm' | 'i', values: string[]): string {
  if (action === 'i') {
    const intensity = INTENSITIES[Number(values[0])] ?? INTENSITIES[0]
    return formatCoreText(
      language,
      Number(values[0]) === 0
        ? 'eewbot.scmd.setup.sensitivity.followup.unknown'
        : 'eewbot.scmd.setup.sensitivity.followup',
      intensity,
    )
  }
  const group = action === 'b' ? 'base' : 'modifier'
  return values.length === 0
    ? coreText(language, `eewbot.scmd.setup.${group}.followup.none`)
    : formatCoreText(
        language,
        `eewbot.scmd.setup.${group}.followup.any`,
        values.map((value) => setupOptionText(language, group, value, 'label')).join(', '),
      )
}
