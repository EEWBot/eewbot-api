import { coreText } from './core'

const keys = {
  title: 'title',
  desc: 'desc',
  setup: 'field.set.value',
  quakeinfo: 'field.quakeinfo.value',
  invite: 'field.invite.value',
  testmessage: 'field.testmessage.value',
  lang: 'field.lang.value',
  unregister: 'field.unregister.value',
  help: 'field.help.value',
  linksName: 'field.links.name',
  links: 'field.links.value',
  legalName: 'field.legal.name',
  legal: 'field.legal.value',
} as const

export function helpText(language: string, key: keyof typeof keys): string {
  return coreText(language, `eewbot.scmd.help.${keys[key]}`)
}
