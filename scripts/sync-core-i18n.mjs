import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = path.join(root, 'src/i18n/core-messages.ts')

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
    const source = await generateCoreI18n(path.resolve(process.env.EEWBOT_CORE_DIR ?? path.join(root, '..')))
    if (process.argv.includes('--check')) {
      if ((await readFile(output, 'utf8')).replace(/\r\n/g, '\n') !== source)
        throw new Error('Core translations differ. Run npm run i18n:sync and commit the result.')
      console.log('Translations match Java Core.')
    } else {
      await writeFile(output, source, 'utf8')
      console.log('Synchronized Java Core translations.')
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
