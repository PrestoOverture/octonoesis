import { afterEach, beforeEach, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../../../src/config/schema'
import {
  loadFileHistory,
  pruneFileHistory,
  recordFileHistoryCommand,
  writeWithCheckpoint,
} from '../../../src/state/fileHistory'
import { runRewind } from '../../../src/state/rewind'
import { bashTool } from '../../../src/tools/Bash'
import type { ToolContext } from '../../../src/tools/Tool'

let root: string
let memoryDir: string
let ctx: ToolContext
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retention-')))
  memoryDir = path.join(root, 'memory')
  ctx = { repoRoot: root, memoryDir, sessionId: 'current' }
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
async function session(id: string, ts: string) {
  const directory = path.join(memoryDir, 'file-history', id)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      repoRoot: root,
      entries: [],
      commands: [{ afterSeq: 0, ts, command: 'echo old' }],
    }),
  )
  return directory
}
it('validates retention configuration and defaults to 30', () => {
  expect(parseConfig({}).fileHistory.retentionDays).toBe(30)
  expect(parseConfig({ fileHistory: {} }).fileHistory?.retentionDays).toBe(30)
  expect(parseConfig({ fileHistory: { retentionDays: 0 } }).fileHistory?.retentionDays).toBe(0)
  for (const retentionDays of [-1, 1.5, '2'])
    expect(() => parseConfig({ fileHistory: { retentionDays } })).toThrow()
})
it('prunes old and invalid sessions, keeping recent/current/locked sessions and symlinks', async () => {
  const old = '2000-01-01T00:00:00.000Z'
  await session('old', old)
  await session('current', old)
  await session('recent', new Date().toISOString())
  const locked = await session('locked', old)
  await fs.writeFile(path.join(locked, '.lock'), JSON.stringify({ pid: process.pid }))
  const invalid = await session('invalid', old)
  await fs.writeFile(path.join(invalid, 'manifest.json'), 'invalid')
  await fs.utimes(invalid, new Date(old), new Date(old))
  await fs.symlink(root, path.join(memoryDir, 'file-history', 'escape'))
  expect(await pruneFileHistory(memoryDir, 0, 'current')).toEqual([])
  expect(await fs.readdir(path.join(memoryDir, 'file-history'))).toContain('old')
  expect((await pruneFileHistory(memoryDir, 30, 'current')).sort()).toEqual(['invalid', 'old'])
  expect((await fs.readdir(path.join(memoryDir, 'file-history'))).sort()).toEqual([
    'current',
    'escape',
    'locked',
    'recent',
  ])
})
it('prints removed sessions for --prune and honors --days 0', async () => {
  await session('old', '2000-01-01T00:00:00.000Z')
  const originalLog = console.log
  const calls: unknown[][] = []
  console.log = (...args: unknown[]) => {
    calls.push(args)
  }
  try {
    await runRewind({ prune: true, days: '0' }, root, memoryDir)
    expect(calls.flat().join('\n')).toContain('No file history sessions removed.')
    await runRewind({ prune: true, days: '1' }, root, memoryDir)
    expect(calls.flat().join('\n')).toContain('Removed old')
  } finally {
    console.log = originalLog
  }
})
it('records foreground and background Bash commands with file counts and truncation', async () => {
  expect((await bashTool.call({ command: 'true' }, ctx)).ok).toBe(true)
  await writeWithCheckpoint(ctx, 'Write', path.join(root, 'file'), 'one')
  expect(
    (await bashTool.call({ command: `true #${'x'.repeat(220)}`, run_in_background: true }, ctx)).ok,
  ).toBe(true)
  const history = await loadFileHistory(memoryDir, 'current', root)
  expect(history.commands?.map((command) => command.afterSeq)).toEqual([0, 1])
  expect(history.commands?.[0]?.command).toBe('true')
  expect(history.commands?.[1]?.command.length).toBe(200)
})
it('interleaves commands, counts command-only sessions, and warns about exactly later commands', async () => {
  await recordFileHistoryCommand(ctx, 'early')
  const originalLog = console.log
  const calls: unknown[][] = []
  console.log = (...args: unknown[]) => {
    calls.push(args)
  }
  try {
    await runRewind({ list: true }, root, memoryDir)
    expect(calls.flat().join('\n')).toContain('1 changes')
    await writeWithCheckpoint(ctx, 'Write', path.join(root, 'a'), 'a')
    await recordFileHistoryCommand(ctx, 'boundary')
    await writeWithCheckpoint(ctx, 'Write', path.join(root, 'b'), 'b')
    await recordFileHistoryCommand(ctx, 'late')
    calls.length = 0
    await runRewind({ session: 'current' }, root, memoryDir)
    const output = calls.flat().join('\n')
    expect(output.indexOf('$ early')).toBeLessThan(output.indexOf('1 Write'))
    expect(output.indexOf('1 Write')).toBeLessThan(output.indexOf('$ boundary'))
    expect(output.indexOf('$ boundary')).toBeLessThan(output.indexOf('2 Write'))
    expect(output.indexOf('2 Write')).toBeLessThan(output.indexOf('$ late'))
    calls.length = 0
    await runRewind({ session: 'current', to: '2', yes: true }, root, memoryDir)
    const warning = calls
      .flat()
      .join('\n')
      .split('These shell commands ran after this point and will NOT be reverted')[1]
    expect(warning).toBeDefined()
    expect(warning).toContain('$ boundary')
    expect(warning).toContain('$ late')
    expect(warning).not.toContain('$ early')
  } finally {
    console.log = originalLog
  }
})
it('loads legacy manifests without commands', async () => {
  const directory = await session('legacy', new Date().toISOString())
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({ repoRoot: root, entries: [] }),
  )
  expect(await loadFileHistory(memoryDir, 'legacy', root)).toEqual({ repoRoot: root, entries: [] })
})

it('prunes only on the first checkpoint in a process and honors configured zero', async () => {
  const moduleUrl = new URL('../../../src/state/fileHistory.ts', import.meta.url).href
  const old = '2000-01-01T00:00:00.000Z'
  for (const days of [0, 30]) {
    await session('expired', old)
    const script = `
      import fs from 'node:fs/promises';
      import { writeWithCheckpoint } from ${JSON.stringify(moduleUrl)};
      const ctx = ${JSON.stringify({ repoRoot: root, memoryDir, sessionId: 'current' })};
      ctx.config = { fileHistory: { retentionDays: ${days} } };
      await writeWithCheckpoint(ctx, 'Write', ${JSON.stringify(path.join(root, 'a'))}, 'one');
      const expired = ${JSON.stringify(path.join(memoryDir, 'file-history', 'expired'))};
      console.log(await fs.access(expired).then(() => 'kept', () => 'removed'));
      await fs.mkdir(expired, { recursive: true });
      await fs.writeFile(expired + '/manifest.json', JSON.stringify({ repoRoot: ctx.repoRoot, entries: [], commands: [{afterSeq: 0, ts: '${old}', command: 'true'}] }));
      await writeWithCheckpoint(ctx, 'Write', ${JSON.stringify(path.join(root, 'a'))}, 'two');
      console.log(await fs.access(expired).then(() => 'kept', () => 'removed'));
    `
    expect(
      execFileSync(process.execPath, ['--no-env-file', '--eval', script], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(days === 0 ? 'kept\nkept' : 'removed\nkept')
  }
})
it('warns on recording failure while Bash still executes', async () => {
  await fs.mkdir(memoryDir)
  await fs.writeFile(path.join(memoryDir, 'file-history'), 'blocked')
  const originalError = console.error
  const warnings: string[] = []
  console.error = (message: unknown) => {
    warnings.push(String(message))
  }
  try {
    expect((await bashTool.call({ command: 'true' }, ctx)).ok).toBe(true)
    expect(warnings.join('')).toContain('Warning: file checkpoint unavailable')
  } finally {
    console.error = originalError
  }
})
