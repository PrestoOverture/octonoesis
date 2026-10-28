import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultCachedExtractor } from '../../../src/memory/fingerprint/cache'
import { flushJournal } from '../../../src/memory/journal'
import { verify } from '../../../src/memory/verifier'
import { registerPromptHandler, unregisterPromptHandler } from '../../../src/permissions/confirm'
import { setProvider } from '../../../src/providers'
import type { QueryLoopContext } from '../../../src/query/types'
import { bashTool } from '../../../src/tools/Bash'
import type { Tool } from '../../../src/tools/Tool'
import { runTool } from '../../../src/tools/execute'
import { registerTool } from '../../../src/tools/registry'
import { restoreEnv } from '../../helpers/env'
import { restoreRegistry, snapshotRegistry } from '../../helpers/globalState'

describe('Bash bounded output', () => {
  let repoRoot: string
  let savedMemory: string | undefined
  let registry: Tool[]
  beforeEach(async () => {
    repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bash-bounds-')))
    savedMemory = process.env.OCTONOESIS_MEMORY_DIR
    process.env.OCTONOESIS_MEMORY_DIR = path.join(repoRoot, 'memory')
    registry = snapshotRegistry()
    registerTool(bashTool)
    registerPromptHandler(async () => 'allow_once')
  })
  afterEach(async () => {
    await flushJournal()
    await defaultCachedExtractor.clearForTesting()
    setProvider(null)
    unregisterPromptHandler()
    restoreRegistry(registry)
    restoreEnv('OCTONOESIS_MEMORY_DIR', savedMemory)
    await fs.rm(repoRoot, { recursive: true, force: true })
  })
  async function run(command: string) {
    const result = await bashTool.call({ command }, { repoRoot })
    if (!result.ok) throw new Error(result.error)
    return JSON.parse(result.value)
  }
  test('seq 1 3000000 retains the last line and spills the full output to a log', async () => {
    const output = await run('seq 1 3000000')
    expect(output.code).toBe(0)
    expect(output.truncated).toBe(true)
    expect(output.stdout.length <= 30_000).toBe(true)
    expect(output.stdout.startsWith('1\n2\n3\n')).toBe(true)
    expect(output.stdout).toContain('[output truncated]')
    // BSD seq uses scientific notation at this scale; compare the actual native stream.
    const expected = execFileSync('seq', ['1', '3000000'], {
      encoding: 'utf8',
      maxBuffer: 40_000_000,
    })
    expect(output.stdout.endsWith(expected.slice(-100))).toBe(true)
    expect(path.isAbsolute(output.output_log)).toBe(false)
    const log = await fs.readFile(path.resolve(repoRoot, output.output_log), 'utf8')
    expect(log).toBe(expected)
  }, 30_000)
  test('bounds stderr independently, retains both heads and tails, and merges full streams in the log', async () => {
    const output = await run('seq 1 10000; seq 20001 30000 >&2')
    expect(output.truncated).toBe(true)
    expect(output.stdout.length <= 30_000).toBe(true)
    expect(output.stderr.length <= 10_000).toBe(true)
    expect(output.stdout.startsWith('1\n')).toBe(true)
    expect(output.stdout.endsWith('10000\n')).toBe(true)
    expect(output.stderr.startsWith('20001\n')).toBe(true)
    expect(output.stderr.endsWith('30000\n')).toBe(true)
    const log = await fs.readFile(path.resolve(repoRoot, output.output_log), 'utf8')
    expect(log.length).toBe(48_894 + 60_000)
    expect(log).toContain('20001\n')
  })
  test('uses the configured outside log directory and collision-safe filenames', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-bash-'))
    process.env.OCTONOESIS_MEMORY_DIR = outside
    try {
      const first = await run('seq 1 10000')
      const second = await run('seq 1 10000')
      expect(path.isAbsolute(first.output_log)).toBe(true)
      expect(first.output_log).not.toBe(second.output_log)
      expect(path.dirname(first.output_log)).toBe(await fs.realpath(path.join(outside, 'tasks')))
      expect(await fs.readFile(first.output_log, 'utf8')).toBe(
        await fs.readFile(second.output_log, 'utf8'),
      )
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
  test('does not add metadata or retain logs for short output', async () => {
    expect(await run("printf 'short'; printf 'error' >&2")).toEqual({
      code: 0,
      stdout: 'short',
      stderr: 'error',
    })
    expect(await fs.readdir(path.join(repoRoot, 'memory/tasks'))).toEqual([])
  })
  test('fingerprinting and repeated verification receive the error tail and preserve log metadata', async () => {
    const seen: string[] = []
    setProvider({
      name: 'anthropic',
      createMessageStream: async function* (messages) {
        seen.push(JSON.stringify(messages))
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            tool: 'test',
            error_class: 'TailError',
            file: 'tail.ts',
            expression: 'tail',
          }),
        }
      },
    })
    const command =
      "seq 1 20000 >&2; printf '%s: %s\\n' TailError 'end-of-stream failure' >&2; exit 1"
    const ctx: QueryLoopContext = { repoRoot, verificationCommand: command }
    const direct = await verify(command, repoRoot)
    expect(direct.verdict).toBe('FAIL')
    expect(direct.stderr?.endsWith('TailError: end-of-stream failure\n')).toBe(true)
    expect(seen.join('')).toContain('TailError: end-of-stream failure')
    const result = await runTool('Bash', { command }, ctx)
    if (!result.ok) throw new Error(result.error)
    const output = JSON.parse(result.value as string)
    expect(output.truncated).toBe(true)
    expect((await fs.stat(path.resolve(repoRoot, output.output_log))).isFile()).toBe(true)
    expect(
      ctx._lastVerifyResultForQuery?.stderr?.endsWith('TailError: end-of-stream failure\n'),
    ).toBe(true)
    const normalCtx: QueryLoopContext = { repoRoot }
    const normal = await runTool('Bash', { command }, normalCtx)
    expect(normal.ok).toBe(true)
    expect(normalCtx._lastFingerprints?.[0]?.error_class).toBe('TailError')
  })
})
