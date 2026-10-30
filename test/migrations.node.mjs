import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { test } from 'node:test'

test('D1 migrations use distinct sequence numbers', async () => {
  const files = (await readdir(new URL('../migrations/', import.meta.url)))
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const sequences = new Map()
  for (const file of files) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file)
    assert.ok(match, `Invalid migration filename: ${file}`)
    const sequence = Number(match[1])
    assert.ok(
      !sequences.has(sequence),
      `Duplicate migration sequence ${match[1]}: ${sequences.get(sequence)} and ${file}`,
    )
    sequences.set(sequence, file)
  }
})
