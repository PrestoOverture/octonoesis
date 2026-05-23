import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { readFile } from '../../../src/tools/Read'

describe('Read tool', () => {
  it('reads an existing file', async () => {
    const result = await readFile({ path: join(import.meta.dir, '../../../package.json') })
    expect(result).toContain('"name": "octonoesis"')
  })

  it('rejects a nonexistent file', async () => {
    await expect(readFile({ path: '/nonexistent/file.txt' })).rejects.toThrow()
  })
})
