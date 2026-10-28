import { afterEach, beforeEach, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm'
import { recordFileRead } from '../../../src/state/fileState'
import { editTool } from '../../../src/tools/Edit'
import type { ToolContext } from '../../../src/tools/Tool'
import { writeTool } from '../../../src/tools/Write'
import { runTool } from '../../../src/tools/execute'
import { registerTool } from '../../../src/tools/registry'
import { restoreEnv } from '../../helpers/env'

let root: string
let ctx: ToolContext
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-history-')))
  process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory')
  ctx = { repoRoot: root, sessionId: 'checkpoints' }
  registerTool(writeTool)
  registerTool(editTool)
  clearAllowlist()
})

afterEach(async () => {
  unregisterPromptHandler()
  clearAllowlist()
  restoreEnv('OCTONOESIS_MEMORY_DIR', originalMemoryDir)
  await fs.rm(root, { recursive: true, force: true })
})

function historyDir() {
  return path.join(root, 'memory/file-history/checkpoints')
}

it('records ordered prior bytes for Write overwrite/create and consecutive Edits', async () => {
  const file = path.join(root, 'existing.txt')
  await fs.writeFile(file, 'before\n')
  recordFileRead(ctx, file, 'before\n')
  expect((await writeTool.call({ path: 'existing.txt', content: 'written\n' }, ctx)).ok).toBe(true)
  expect((await writeTool.call({ path: 'new.txt', content: 'created' }, ctx)).ok).toBe(true)
  expect(
    (
      await editTool.call(
        { path: 'existing.txt', old_string: 'written', new_string: 'edited' },
        ctx,
      )
    ).ok,
  ).toBe(true)
  expect(
    (await editTool.call({ path: 'existing.txt', old_string: 'edited', new_string: 'again' }, ctx))
      .ok,
  ).toBe(true)

  const manifest = JSON.parse(await fs.readFile(path.join(historyDir(), 'manifest.json'), 'utf8'))
  expect(manifest.repoRoot).toBe(root)
  expect(
    manifest.entries.map((entry: { seq: number; tool: string; path: string }) => [
      entry.seq,
      entry.tool,
      entry.path,
    ]),
  ).toEqual([
    [1, 'Write', 'existing.txt'],
    [2, 'Write', 'new.txt'],
    [3, 'Edit', 'existing.txt'],
    [4, 'Edit', 'existing.txt'],
  ])
  expect(manifest.entries[1].snapshot).toBe('absent')
  for (const [index, content] of [
    [0, 'before\n'],
    [2, 'written\n'],
    [3, 'edited\n'],
  ] as const) {
    const entry = manifest.entries[index]
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false)
    expect(await fs.readFile(path.join(historyDir(), entry.snapshot), 'utf8')).toBe(content)
  }
})

it('records nothing for invalid, denied, stale, missing-parent or failed filesystem writes', async () => {
  registerPromptHandler(async () => 'deny')
  expect((await runTool('Write', { path: '', content: 'invalid' }, ctx)).ok).toBe(false)
  expect((await runTool('Write', { path: 'denied', content: 'denied' }, ctx)).ok).toBe(false)
  await fs.writeFile(path.join(root, 'unread'), 'original')
  expect((await writeTool.call({ path: 'unread', content: 'no' }, ctx)).ok).toBe(false)
  expect((await writeTool.call({ path: 'missing/file', content: 'no' }, ctx)).ok).toBe(false)
  await fs.mkdir(path.join(root, 'directory'))
  recordFileRead(ctx, path.join(root, 'directory'), '')
  expect((await writeTool.call({ path: 'directory', content: 'no' }, ctx)).ok).toBe(false)
  expect(existsSync(historyDir())).toBe(false)
  expect(existsSync(path.join(root, 'denied'))).toBe(false)
  expect(await fs.readFile(path.join(root, 'unread'), 'utf8')).toBe('original')
})

it('does not publish a checkpoint when the actual write fails after staging', async () => {
  const originalWrite = fs.writeFile.bind(fs)
  const target = path.join(root, 'failure.txt')
  fs.writeFile = async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === target) throw new Error('simulated target write failure')
    return originalWrite(...args)
  }
  try {
    const result = await writeTool.call({ path: 'failure.txt', content: 'no' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('simulated target write failure')
    expect(existsSync(path.join(historyDir(), 'manifest.json'))).toBe(false)
    expect(existsSync(target)).toBe(false)
  } finally {
    fs.writeFile = originalWrite
  }
})

it('keeps Write and Edit successful and emits one-line warnings when snapshot storage fails', async () => {
  await fs.mkdir(path.join(root, 'memory'))
  await fs.writeFile(path.join(root, 'memory/file-history'), 'blocking file')
  const originalError = console.error
  const warnings: string[] = []
  console.error = (message: unknown) => {
    warnings.push(String(message))
  }
  try {
    expect((await writeTool.call({ path: 'new.txt', content: 'new' }, ctx)).ok).toBe(true)
    recordFileRead(ctx, path.join(root, 'new.txt'), 'new')
    expect(
      (await editTool.call({ path: 'new.txt', old_string: 'new', new_string: 'edited' }, ctx)).ok,
    ).toBe(true)
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('edited')
    expect(warnings.length).toBe(2)
    for (const warning of warnings) {
      expect(warning).toContain('Warning: file checkpoint')
      expect(warning).not.toContain('\n')
    }
  } finally {
    console.error = originalError
  }
})
