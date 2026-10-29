import { afterEach, beforeEach, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { recordFileRead } from '../../src/state/fileState'
import { editTool } from '../../src/tools/Edit'
import type { ToolContext } from '../../src/tools/Tool'
import { writeTool } from '../../src/tools/Write'

// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the test runtime.
declare const Bun: any

const cli = path.resolve('src/cli.tsx')
let root: string
let memoryDir: string
let ctx: ToolContext

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-rewind-')))
  memoryDir = path.join(root, 'memory')
  ctx = { repoRoot: root, memoryDir, sessionId: 'rewind-session' }
  await fs.writeFile(path.join(root, 'edited.txt'), 'pre-session\n')
  recordFileRead(ctx, path.join(root, 'edited.txt'), 'pre-session\n')
  expect(
    (
      await editTool.call(
        { path: 'edited.txt', old_string: 'pre-session', new_string: 'first' },
        ctx,
      )
    ).ok,
  ).toBe(true)
  expect((await writeTool.call({ path: 'created.txt', content: 'created' }, ctx)).ok).toBe(true)
  expect(
    (await editTool.call({ path: 'edited.txt', old_string: 'first', new_string: 'last' }, ctx)).ok,
  ).toBe(true)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function rewind(args: string[], answer = '', repoRoot = root) {
  const env = { ...process.env, OCTONOESIS_REPO_ROOT: repoRoot, OCTONOESIS_MEMORY_DIR: memoryDir }
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SPARK_API_KEY'])
    Reflect.deleteProperty(env, key)
  const child = Bun.spawn([process.execPath, '--no-env-file', cli, 'rewind', ...args], {
    cwd: repoRoot,
    env,
    stdin: new Blob([answer]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

it('rewind --session --to 1 --yes restores pre-session bytes and deletes created files', async () => {
  const result = await rewind(['--session', 'rewind-session', '--to', '1', '--yes'])
  expect(result.code).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('restore edited.txt')
  expect(result.stdout).toContain('delete created.txt')
  expect(await fs.readFile(path.join(root, 'edited.txt'), 'utf8')).toBe('pre-session\n')
  expect(existsSync(path.join(root, 'created.txt'))).toBe(false)
})

it('uses the first snapshot at or after a noninitial sequence for each touched file', async () => {
  expect((await rewind(['--to', '2', '--yes'])).code).toBe(0)
  expect(await fs.readFile(path.join(root, 'edited.txt'), 'utf8')).toBe('first\n')
  expect(existsSync(path.join(root, 'created.txt'))).toBe(false)
})

it('prints a plan and defaults to cancellation, and accepts y', async () => {
  const cancelled = await rewind(['--to', '1'], '\n')
  expect(cancelled.code).toBe(0)
  expect(cancelled.stdout).toContain('restore edited.txt')
  expect(cancelled.stdout).toContain('y/N')
  expect(await fs.readFile(path.join(root, 'edited.txt'), 'utf8')).toBe('last\n')
  expect((await rewind(['--to', '1'], 'y\n')).code).toBe(0)
  expect(await fs.readFile(path.join(root, 'edited.txt'), 'utf8')).toBe('pre-session\n')
})

it('refuses external modifications before changing any file, and permits --force', async () => {
  await fs.writeFile(path.join(root, 'created.txt'), 'external')
  const refused = await rewind(['--to', '1', '--yes'])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain('changed after')
  expect(await fs.readFile(path.join(root, 'edited.txt'), 'utf8')).toBe('last\n')
  expect(await fs.readFile(path.join(root, 'created.txt'), 'utf8')).toBe('external')
  expect((await rewind(['--to', '1', '--yes', '--force'])).code).toBe(0)
  expect(await fs.readFile(path.join(root, 'edited.txt'), 'utf8')).toBe('pre-session\n')
  expect(existsSync(path.join(root, 'created.txt'))).toBe(false)
})

it('refuses a symlink escape even with --force before restoring anything', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rewind-outside-'))
  try {
    await fs.writeFile(path.join(outside, 'canary'), 'outside')
    await fs.rm(path.join(root, 'created.txt'))
    await fs.symlink(path.join(outside, 'canary'), path.join(root, 'created.txt'))
    const result = await rewind(['--to', '1', '--yes', '--force'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('outside')
    expect(await fs.readFile(path.join(outside, 'canary'), 'utf8')).toBe('outside')
    expect(await fs.readFile(path.join(root, 'edited.txt'), 'utf8')).toBe('last\n')
  } finally {
    await fs.rm(outside, { recursive: true, force: true })
  }
})

it('lists recent sessions and numbered changes, selecting only this repo by default', async () => {
  const otherRoot = path.join(root, 'other')
  await fs.mkdir(otherRoot)
  expect(
    (
      await writeTool.call(
        { path: 'other.txt', content: 'other' },
        { repoRoot: otherRoot, memoryDir, sessionId: 'other-session' },
      )
    ).ok,
  ).toBe(true)
  const listing = await rewind(['--list'])
  expect(listing.code).toBe(0)
  expect(listing.stdout).toContain('rewind-session')
  expect(listing.stdout).toContain('3 changes')
  expect(listing.stdout).not.toContain('other-session')
  const changes = await rewind([])
  expect(changes.code).toBe(0)
  expect(changes.stdout).toContain('1 Edit edited.txt')
  expect(changes.stdout).toContain('2 Write created.txt')
  expect(changes.stdout).toContain('3 Edit edited.txt')
  const explicit = await rewind(['--session', 'rewind-session'])
  expect(explicit.stdout).toBe(changes.stdout)
  expect((await rewind(['--session', 'other-session', '--to', '1', '--yes'])).code).toBe(1)
})
