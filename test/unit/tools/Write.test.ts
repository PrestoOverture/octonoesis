import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getRepoRoot } from '../../../src/query'
import { readTool } from '../../../src/tools/Read'
import { writeTool } from '../../../src/tools/Write'

describe('Write tool', () => {
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }
  const testFileName = 'test-write-tool-tmp.txt'
  const testFilePath = join(repoRoot, testFileName)

  afterEach(async () => {
    try {
      await unlink(testFilePath)
    } catch {}
  })

  it('creates a new file with specified content', async () => {
    const result = await writeTool.call({ path: testFileName, content: 'hello write tool' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toContain('successfully created')
    }

    // Verify it was actually written using Read tool
    const readResult = await readTool.call({ path: testFileName }, ctx)
    expect(readResult.ok).toBe(true)
    if (readResult.ok) {
      expect(readResult.value).toContain('hello write tool')
    }
  })

  it('rejects writing to an existing file', async () => {
    // Write initial file
    await writeFile(testFilePath, 'existing', 'utf-8')

    const result = await writeTool.call({ path: testFileName, content: 'overwrite try' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('file_exists')
    }
  })

  it('rejects if parent directory does not exist', async () => {
    const result = await writeTool.call(
      { path: 'nonexistent-dir/new-file.txt', content: 'content' },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('parent_dir_not_found')
    }
  })

  it('blocks path traversal outside repoRoot', async () => {
    const result = await writeTool.call(
      { path: '../../../../tmp/outside-file.txt', content: 'content' },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('path_outside_repo')
    }
  })
})
