import { coreText } from './core'

export function quakeInfoText(language: string) {
  const text = (key: string) => coreText(language, `eewbot.scmd.quakeinfo.${key}`)
  return {
    error: coreText(language, 'eewbot.scmd.quakeinfo.error'),
    report: text('report'),
    saved: text('saved'),
    old: text('old'),
    partial: text('partial'),
    // Indexed by info type priority: announcement, correction, cancellation.
    kinds: [text('kind.announcement'), text('kind.correction'), text('kind.cancel')] as const,
  }
}
