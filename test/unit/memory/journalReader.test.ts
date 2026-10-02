import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  captureJournalPosition,
  readJournalLines,
  readJournalTextBatches,
} from '../../../src/memory/journalReader'

test('byte chunks preserve split newline text and physical numbering, including suffixes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-reader-'))
  const file = path.join(dir, 'journal.jsonl')
  const content = '\n \r\n{"kind":"unknown","text":"    猫"}\r\n\n{"torn":'
  try {
    await fs.writeFile(file, content)
    const expected = content
      .split('\n')
      .map((text, i) => ({ line: i + 1, text }))
      .filter(({ text }) => text.trim())
    const collect = async (position = { offset: 0, line: 1 }) => {
      const result = []
      for await (const row of readJournalLines(file, position, 7)) result.push(row)
      return result
    }
    // The UTF-8 bytes of 猫 cross a seven-byte chunk boundary.
    expect(Buffer.byteLength(content.slice(0, content.indexOf('猫'))) % 7).toBe(6)
    expect(await collect()).toEqual(expected)
    const prefix = `${content.split('\n').slice(0, 3).join('\n')}\n`
    expect(await collect({ offset: Buffer.byteLength(prefix), line: 4 })).toEqual(
      expected.filter((row) => row.line >= 4),
    )
    expect(await collect({ offset: 2, line: 100 })).toEqual(expected)
    expect(await collect({ offset: 9999, line: 100 })).toEqual(expected)
    expect(await captureJournalPosition(file)).toEqual({
      offset: Buffer.byteLength(content.slice(0, content.lastIndexOf('\n') + 1)),
      line: 5,
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('text batches match split newline text across every small chunk size', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-reader-'))
  const file = path.join(dir, 'journal.jsonl')
  // Short lines put several LFs in one chunk; the long line spans several LF-free chunks.
  const content = `a\nb\n\n{"kind":"unknown","text":"    猫猫"}\r\nc\n \n{"long":"${'x'.repeat(40)}"}\nd\n{"torn":`
  try {
    await fs.writeFile(file, content)
    const expected = content.split('\n').filter((text) => text.trim())
    for (let chunkSize = 1; chunkSize <= 16; chunkSize++) {
      const actual: string[] = []
      for await (const lines of readJournalTextBatches(file, chunkSize))
        actual.push(...lines.filter((text) => text.trim()))
      expect({ chunkSize, actual }).toEqual({ chunkSize, actual: expected })
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
