import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getRepoRoot } from '../../../src/query'
import { checkFileState, computeHash, recordFileRead } from '../../../src/state/fileState'
import type { ToolContext } from '../../../src/tools/Tool'

describe('File State Cache', () => {
  const repoRoot = getRepoRoot()
  const testFilePath = join(repoRoot, 'test-file-state-tmp.txt')
  let ctx: ToolContext

  beforeEach(async () => {
    ctx = { repoRoot }
    await writeFile(testFilePath, 'initial content', 'utf-8')
  })

  afterEach(async () => {
    try {
      await unlink(testFilePath)
    } catch {}
  })

  it('rejects files that have not been read (must_read_first)', async () => {
    const status = await checkFileState(ctx, testFilePath)
    expect(status).toBe('must_read_first')
  })

  it('allows files that have been read and remain unchanged', async () => {
    recordFileRead(ctx, testFilePath, 'initial content')
    const status = await checkFileState(ctx, testFilePath)
    expect(status).toBe('ok')
  })

  it('rejects files that have been modified on disk since they were read', async () => {
    recordFileRead(ctx, testFilePath, 'initial content')

    // Modify file on disk
    await writeFile(testFilePath, 'modified content', 'utf-8')

    const status = await checkFileState(ctx, testFilePath)
    expect(status).toBe('file_changed_since_read')
  })

  it('computes correct sha256 hash', () => {
    const content = 'hello world'
    const expectedHash = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    expect(computeHash(content)).toBe(expectedHash)
  })
})
