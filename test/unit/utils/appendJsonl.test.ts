import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendJsonl } from '../../../src/utils/appendJsonl'

test('appendJsonl rechecks a torn tail after a failed append', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'append-jsonl-'))
  try {
    const target = path.join(dir, 'ledger.jsonl')
    const lineA = JSON.stringify({ line: 'A' })
    const lineC = JSON.stringify({ line: 'C' })
    await appendJsonl(target, `${lineA}\n`)
    expect(await fs.readFile(target, 'utf8')).toBe(`${lineA}\n`)

    await fs.rm(target)
    await fs.mkdir(target)
    await expect(appendJsonl(target, '{"line":"B"}\n')).rejects.toThrow('EISDIR')
    await fs.rm(target, { recursive: true })
    await fs.writeFile(target, `${lineA}\n{"torn":`)

    await appendJsonl(target, `${lineC}\n`)
    const lines = (await fs.readFile(target, 'utf8')).split('\n')
    expect(lines).toEqual([lineA, '{"torn":', lineC, ''])
    expect(JSON.parse(lines[2] ?? '')).toEqual({ line: 'C' })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
