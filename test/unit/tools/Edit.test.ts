import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getRepoRoot } from '../../../src/query'
import { editTool } from '../../../src/tools/Edit'
import { readTool } from '../../../src/tools/Read'

describe('Edit tool', () => {
  const repoRoot = getRepoRoot()
  let ctx = { repoRoot }
  const testFileName = 'test-edit-tool-tmp.txt'
  const testFilePath = join(repoRoot, testFileName)

  beforeEach(async () => {
    ctx = { repoRoot }
    // Write initial test content
    await writeFile(testFilePath, 'initial file content\nline two\nline three', 'utf-8')
  })

  afterEach(async () => {
    try {
      await unlink(testFilePath)
    } catch {}
  })

  it('rejects if the file was not read first', async () => {
    const editResult = await editTool.call(
      { path: testFileName, old_string: 'line two', new_string: 'line updated' },
      ctx,
    )
    expect(editResult.ok).toBe(false)
    if (!editResult.ok) {
      expect(editResult.error).toContain('must_read_first')
    }
  })

  it('performs exact single string replacement when read first', async () => {
    // 1. Read first to cache state
    const readResult = await readTool.call({ path: testFileName }, ctx)
    expect(readResult.ok).toBe(true)

    // 2. Edit
    const editResult = await editTool.call(
      { path: testFileName, old_string: 'line two', new_string: 'line updated' },
      ctx,
    )
    expect(editResult.ok).toBe(true)

    // 3. Read again to verify content
    const verifyResult = await readTool.call({ path: testFileName }, ctx)
    expect(verifyResult.ok).toBe(true)
    if (verifyResult.ok) {
      expect(verifyResult.value).toContain('line updated')
      expect(verifyResult.value).not.toContain('line two')
    }
  })

  it('rejects if the file has changed on disk since read', async () => {
    // 1. Read first
    await readTool.call({ path: testFileName }, ctx)

    // 2. Modify on disk behind agent's back
    await writeFile(testFilePath, 'modified on disk', 'utf-8')

    // 3. Edit should fail
    const editResult = await editTool.call(
      { path: testFileName, old_string: 'line two', new_string: 'line updated' },
      ctx,
    )
    expect(editResult.ok).toBe(false)
    if (!editResult.ok) {
      expect(editResult.error).toContain('file_changed_since_read')
    }
  })

  it('rejects if old_string is not found', async () => {
    await readTool.call({ path: testFileName }, ctx)

    const editResult = await editTool.call(
      { path: testFileName, old_string: 'nonexistent-line', new_string: 'updated' },
      ctx,
    )
    expect(editResult.ok).toBe(false)
    if (!editResult.ok) {
      expect(editResult.error).toContain('not found')
    }
  })

  it('rejects if old_string matches multiple times', async () => {
    // Setup file with duplicate strings
    await writeFile(testFilePath, 'duplicate\nline two\nduplicate', 'utf-8')
    await readTool.call({ path: testFileName }, ctx)

    const editResult = await editTool.call(
      { path: testFileName, old_string: 'duplicate', new_string: 'updated' },
      ctx,
    )
    expect(editResult.ok).toBe(false)
    if (!editResult.ok) {
      expect(editResult.error).toContain('Multiple occurrences')
    }
  })

  it('allows a 300-changed-line Edit', async () => {
    const oldContent = `${Array.from({ length: 150 }, (_, i) => `old ${i}`).join('\n')}\n`
    const newContent = `${Array.from({ length: 150 }, (_, i) => `new ${i}`).join('\n')}\n`
    await writeFile(testFilePath, oldContent)
    await readTool.call({ path: testFileName }, ctx)
    const result = await editTool.call(
      { path: testFileName, old_string: oldContent, new_string: newContent },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(await readFile(testFilePath, 'utf-8')).toBe(newContent)
  })

  it('replace_all replaces all three occurrences with literal replacement text', async () => {
    await writeFile(testFilePath, 'duplicate\nduplicate\nduplicate')
    await readTool.call({ path: testFileName }, ctx)
    const input = editTool.inputSchema.parse({
      path: testFileName,
      old_string: 'duplicate',
      new_string: '$& updated',
      replace_all: true,
    })
    const result = await editTool.call(input, ctx)
    expect(result.ok).toBe(true)
    expect(await readFile(testFilePath, 'utf-8')).toBe('$& updated\n$& updated\n$& updated')
  })

  it('replace_all false still rejects multiple matches', async () => {
    await writeFile(testFilePath, 'duplicate duplicate duplicate')
    await readTool.call({ path: testFileName }, ctx)
    const input = editTool.inputSchema.parse({
      path: testFileName,
      old_string: 'duplicate',
      new_string: 'updated',
      replace_all: false,
    })
    const result = await editTool.call(input, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Multiple occurrences')
    expect(await readFile(testFilePath, 'utf-8')).toBe('duplicate duplicate duplicate')
  })

  it('replace_all still rejects missing old_string', async () => {
    await readTool.call({ path: testFileName }, ctx)
    const input = editTool.inputSchema.parse({
      path: testFileName,
      old_string: 'missing',
      new_string: 'updated',
      replace_all: true,
    })
    const result = await editTool.call(input, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('not found')
  })
})
