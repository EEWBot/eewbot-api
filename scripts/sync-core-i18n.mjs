import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = path.join(root, 'src/i18n/core-messages.ts')
const descriptionsOutput = path.join(root, 'src/i18n/command-descriptions.json')

export async function generateCommandDescriptions(core) {
  const descriptions = {}
  for (const locale of ['ja_JP', 'en_US']) {
    const resource = JSON.parse(
      await readFile(path.join(core, 'src/main/resources/lang', locale, 'eewbot.json'), 'utf8'),
    )
    descriptions[locale.toLowerCase()] = Object.fromEntries(
      Object.entries(resource).filter(([key]) => /^eewbot\.scmd\.[^.]+\.description$/.test(key)),
    )
  }
  return `${JSON.stringify(descriptions, null, 2)}\n`
}

export async function generateCoreI18n(core) {
  const directory = path.join(core, 'src/main/resources/lang')
  const names = JSON.parse(await readFile(path.join(directory, 'languages.json'), 'utf8'))
  const languages = []
  const messages = {}
  for (const [locale, name] of Object.entries(names)) {
    const code = locale.toLowerCase()
    languages.push({ code, name })
    const resource = JSON.parse(await readFile(path.join(directory, locale, 'eewbot.json'), 'utf8'))
    messages[code] = Object.fromEntries(Object.entries(resource).filter(([key]) => key.startsWith('eewbot.scmd.')))
    if (Object.values(messages[code]).some((value) => typeof value !== 'string'))
      throw new Error(`Invalid translations: ${locale}`)
  }
  if (languages[0]?.code !== 'ja_jp') throw new Error('Expected Japanese as the fallback language.')
  return (
    '// Generated from Java Core lang/languages.json and lang/*/eewbot.json.\n' +
    '// Run npm run i18n:sync; do not edit by hand. Missing keys fall back to Japanese.\n' +
    `export const CORE_LANGUAGES = ${JSON.stringify(languages, null, 2)} as const\n\n` +
    `export const CORE_MESSAGES = ${JSON.stringify(messages, null, 2)} as const\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const core = path.resolve(process.env.EEWBOT_CORE_DIR ?? path.join(root, '..'))
    const outputs = [
      [output, await generateCoreI18n(core)],
      [descriptionsOutput, await generateCommandDescriptions(core)],
    ]
    const check = process.argv.includes('--check')
    for (const [file, source] of outputs) {
      if (check) {
        if ((await readFile(file, 'utf8')).replace(/\r\n/g, '\n') !== source)
          throw new Error('Core translations differ. Run npm run i18n:sync and commit the result.')
      } else {
        await writeFile(file, source, 'utf8')
      }
    }
    if (check) {
      console.log('Translations match Java Core.')
    } else {
      console.log('Synchronized Java Core translations.')
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
