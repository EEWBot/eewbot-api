import { coreText } from './core'

export function quakeInfoText(language: string) {
  return {
    error: coreText(language, 'eewbot.scmd.quakeinfo.error'),
    partial: coreText(language, 'eewbot.scmd.quakeinfo.partial'),
  }
}
