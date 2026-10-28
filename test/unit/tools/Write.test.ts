import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm'
import { recordFileRead } from '../../../src/state/fileState'
import { editTool } from '../../../src/tools/Edit'
import { readTool } from '../../../src/tools/Read'
import type { ToolContext } from '../../../src/tools/Tool'
import { writeTool } from '../../../src/tools/Write'
import { runTool } from '../../../src/tools/execute'
import { registerTool } from '../../../src/tools/registry'

describe('Write tool', () => {
  let repoRoot: string
  let ctx: ToolContext
  const testFileName = 'test-write-tool-tmp.txt'
  let testFilePath: string

  beforeEach(async () => {
    repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'write-tool-')))
    ctx = { repoRoot }
    testFilePath = join(repoRoot, testFileName)
    registerTool(writeTool)
    registerTool(editTool)
    registerTool(readTool)
    clearAllowlist()
  })

  afterEach(async () => {
    unregisterPromptHandler()
    clearAllowlist()
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('creates a new file with specified content', async () => {
    const result = await writeTool.call({ path: testFileName, content: 'hello write tool' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toContain('successfully created')
    expect(await readFile(testFilePath, 'utf-8')).toBe('hello write tool')
  })

  it('overwrites an existing file Read in this session', async () => {
    await writeFile(testFilePath, 'existing')
    expect((await readTool.call({ path: testFileName }, ctx)).ok).toBe(true)
    const result = await writeTool.call({ path: testFileName, content: 'replacement' }, ctx)
    expect(result.ok).toBe(true)
    expect(await readFile(testFilePath, 'utf-8')).toBe('replacement')
  })

  it('returns must_read_first for an unread existing file', async () => {
    await writeFile(testFilePath, 'existing')
    const result = await writeTool.call({ path: testFileName, content: 'overwrite try' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('must_read_first')
    expect(await readFile(testFilePath, 'utf-8')).toBe('existing')
  })

  it('does not reuse a Read from another session', async () => {
    await writeFile(testFilePath, 'existing')
    await readTool.call({ path: testFileName }, { repoRoot })
    const result = await writeTool.call({ path: testFileName, content: 'overwrite try' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('must_read_first')
  })

  it('returns file_changed_since_read after an external modification', async () => {
    await writeFile(testFilePath, 'existing')
    await readTool.call({ path: testFileName }, ctx)
    await writeFile(testFilePath, 'external change')
    const result = await writeTool.call({ path: testFileName, content: 'overwrite try' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('file_changed_since_read')
    expect(await readFile(testFilePath, 'utf-8')).toBe('external change')
  })

  it('updates the cache so Edit works after overwrite without another Read', async () => {
    await writeFile(testFilePath, 'existing')
    let prompts = 0
    registerPromptHandler(async () => {
      prompts++
      return 'allow_once'
    })
    await runTool('Read', { path: testFileName }, ctx)
    expect((await runTool('Write', { path: testFileName, content: 'replacement' }, ctx)).ok).toBe(
      true,
    )
    const result = await runTool(
      'Edit',
      { path: testFileName, old_string: 'replacement', new_string: 'edited' },
      ctx,
    )
    expect(prompts).toBe(2)
    expect(result.ok).toBe(true)
    expect(await readFile(testFilePath, 'utf-8')).toBe('edited')
  })

  it('requires permission and supplies old/new content for the overwrite diff', async () => {
    await writeFile(testFilePath, 'existing\n')
    await runTool('Read', { path: testFileName }, ctx)
    const input = { path: testFileName, content: 'replacement\n' }
    let prompted = false
    registerPromptHandler(async (toolName, preview) => {
      prompted = true
      expect(toolName).toBe('Write')
      expect(preview).toEqual({ ...input, old_string: 'existing\n', new_string: input.content })
      expect(await readFile(testFilePath, 'utf-8')).toBe('existing\n')
      return 'deny'
    })
    const result = await runTool('Write', input, ctx)
    expect(prompted).toBe(true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('permission_denied')
    expect(await readFile(testFilePath, 'utf-8')).toBe('existing\n')
  })

  it('does not count permission previewing as a Read', async () => {
    await writeFile(testFilePath, 'existing')
    registerPromptHandler(async () => 'allow_once')
    const result = await runTool('Write', { path: testFileName, content: 'replacement' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('must_read_first')
    expect(await readFile(testFilePath, 'utf-8')).toBe('existing')
  })

  it('rechecks file state after permission approval', async () => {
    await writeFile(testFilePath, 'existing')
    await readTool.call({ path: testFileName }, ctx)
    registerPromptHandler(async () => {
      await writeFile(testFilePath, 'external change during approval')
      return 'allow_once'
    })
    const result = await runTool('Write', { path: testFileName, content: 'replacement' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('file_changed_since_read')
    expect(await readFile(testFilePath, 'utf-8')).toBe('external change during approval')
  })

  it('creates new files through the same permission path without a diff', async () => {
    const input = { path: testFileName, content: 'new file' }
    let prompted = false
    registerPromptHandler(async (toolName, preview) => {
      prompted = true
      expect(toolName).toBe('Write')
      expect(preview).toEqual(input)
      return 'allow_once'
    })
    expect((await runTool('Write', input, ctx)).ok).toBe(true)
    expect(prompted).toBe(true)
    expect(await readFile(testFilePath, 'utf-8')).toBe('new file')
  })

  it('rejects if parent directory does not exist', async () => {
    const result = await writeTool.call(
      { path: 'nonexistent-dir/new-file.txt', content: 'content' },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('parent_dir_not_found')
  })

  it('blocks path traversal outside repoRoot', async () => {
    const result = await writeTool.call(
      { path: '../../../../tmp/outside-file.txt', content: 'content' },
      ctx,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('path_outside_repo')
  })

  it('blocks overwriting a symlink target outside repoRoot even if cached', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'write-outside-')))
    try {
      const outsideFile = join(outside, 'target.txt')
      await writeFile(outsideFile, 'outside')
      recordFileRead(ctx, outsideFile, 'outside')
      await symlink(outsideFile, testFilePath)
      const result = await writeTool.call({ path: testFileName, content: 'overwrite try' }, ctx)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('path_outside_repo')
      expect(await readFile(outsideFile, 'utf-8')).toBe('outside')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
