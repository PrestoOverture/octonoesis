import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaultCachedExtractor } from '../../../src/memory/fingerprint/cache'
import { flushJournal } from '../../../src/memory/journal'
import * as verifier from '../../../src/memory/verifier'
import { registerPromptHandler, unregisterPromptHandler } from '../../../src/permissions/confirm'
import { setProvider } from '../../../src/providers'
import type { QueryLoopContext } from '../../../src/query/types'
import { bashTool } from '../../../src/tools/Bash'
import type { Tool } from '../../../src/tools/Tool'
import { runTool } from '../../../src/tools/execute'
import { registerTool } from '../../../src/tools/registry'
import { restoreEnv } from '../../helpers/env'
import { restoreRegistry, snapshotRegistry } from '../../helpers/globalState'

const { spyOn } = require('bun:test')
let root: string
let savedMemoryDir: string | undefined
let originalTools: Tool[]
let verifySpy: ReturnType<typeof spyOn>
let extractions: number

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'verification-timeout-')))
  savedMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  process.env.OCTONOESIS_MEMORY_DIR = root
  originalTools = snapshotRegistry()
  registerTool(bashTool)
  registerPromptHandler(async () => 'allow_once')
  verifySpy = spyOn(verifier, 'verify')
  extractions = 0
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      extractions++
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          tool: 'bun-test',
          error_class: 'TypeError',
          file: 'src/buggy.ts',
          expression: 'user.name',
        }),
      }
    },
  })
})

afterEach(async () => {
  verifySpy.mockRestore()
  unregisterPromptHandler()
  setProvider(null)
  restoreRegistry(originalTools)
  await flushJournal()
  await defaultCachedExtractor.clearForTesting()
  restoreEnv('OCTONOESIS_MEMORY_DIR', savedMemoryDir)
  await fs.rm(root, { recursive: true, force: true })
})

test('verification with timeout_ms uses verify and preserves fingerprints and journal order', async () => {
  const command = "echo 'TypeError: timed verification at src/buggy.ts:1' >&2; exit 1"
  const ctx: QueryLoopContext = { repoRoot: root, verificationCommand: command }
  const result = await runTool('Bash', { command, timeout_ms: 1000 }, ctx)
  expect(result.ok).toBe(true)
  if (result.ok) expect(JSON.parse(String(result.value)).code).toBe(1)
  expect(extractions).toBe(1)
  const fingerprint = 'bun-test|TypeError|src/buggy.ts|user.name'
  expect(ctx._lastVerifyResultForQuery?.isVerificationRun).toBe(true)
  expect(ctx._lastVerifyResultForQuery?.fingerprints[0]?.fine).toBe(fingerprint)
  expect(ctx._lastFingerprints?.[0]?.fine).toBe(fingerprint)
  await flushJournal()
  const rows = (await fs.readFile(path.join(root, 'journal.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(rows.map((row) => row.kind)).toEqual(['permission', 'verify', 'tool'])
  expect(rows[1].verdict).toBe('FAIL')
  expect(rows[1].command).toBe(command)
  expect(rows[1].fingerprints[0].fine).toBe(fingerprint)
  expect(rows[2].fingerprints[0].fine).toBe(fingerprint)
  // The fallback also emits these events; require the shared verifier too.
  expect(verifySpy.mock.calls.length).toBe(1)
})

test('verification through verify honors timeout_ms and reports the actual limit', async () => {
  const ctx: QueryLoopContext = { repoRoot: root, verificationCommand: 'sleep 3' }
  const started = performance.now()
  const result = await runTool('Bash', { command: 'sleep 3', timeout_ms: 1000 }, ctx)
  expect(performance.now() - started).toBeLessThan(3000)
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error).toContain('timeout:')
    expect(result.error).toContain('1000ms')
  }
  expect(verifySpy.mock.calls.length).toBe(1)
})
