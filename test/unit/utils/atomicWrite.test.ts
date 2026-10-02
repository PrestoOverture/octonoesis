import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from '../../../src/utils/atomicWrite'

test('atomic write cleans up when replacement targets a non-empty directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'))
  try {
    const target = path.join(dir, 'target')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'child'), 'keep')
    await expect(writeFileAtomic(target, 'replacement')).rejects.toThrow()
    expect(await fs.readdir(dir)).toEqual(['target'])
    expect(await fs.readFile(path.join(target, 'child'), 'utf8')).toBe('keep')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
