import { coreText, formatCoreText } from './core'

export type TestMessageKey =
  | 'title'
  | 'webhook'
  | 'nowebhook'
  | 'webhooksender'
  | 'success.webhook'
  | 'success.nowebhook'
  | 'success.webhooksender'
  | 'error.title'
  | 'error.missingperms'
  | 'error.ratelimit'
  | 'error.unknownwebhook'
  | 'error.unknown'
  | 'error.configuration'
  | 'error.unavailable'
  | 'error.uncertain'

export function testMessageText(language: string, key: TestMessageKey): string {
  if (key === 'error.configuration' || key === 'error.unavailable' || key === 'error.uncertain') {
    return coreText(language, `eewbot.scmd.api.testmessage.${key}`)
  }
  // Never put exception details or token-bearing URLs into Java's error argument.
  if (key === 'error.unknown') return formatCoreText(language, `eewbot.scmd.testmessage.${key}`, '')
  return coreText(language, `eewbot.scmd.testmessage.${key}`)
}
