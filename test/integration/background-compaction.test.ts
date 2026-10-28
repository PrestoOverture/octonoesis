// biome-ignore lint/suspicious/noExplicitAny: Bun.spawn is replaced to control child completion.
declare const Bun: any
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../../src/config/schema'
import { flushJournal } from '../../src/memory/journal'
import { setProvider } from '../../src/providers'
import { getActiveForkPids } from '../../src/providers/fork'
import type { CanonicalMessage, LLMProvider } from '../../src/providers/types'
import { query } from '../../src/query'
import { readTool } from '../../src/tools/Read'
import { registerTool } from '../../src/tools/registry'
import { assertPairedHistory } from '../helpers/compactionQuality'
import { restoreEnv } from '../helpers/env'

let root: string
let originalSpawn: typeof Bun.spawn
let originalMain: string
let originalEnv: Record<string, string | undefined>
const keys = [
  'OCTONOESIS_MEMORY_DIR',
  'OCTONOESIS_DISABLE_MEMORY',
  'OCTONOESIS_DISABLE_COMPACT',
  'OCTONOESIS_COMPACT_THRESHOLD',
  'OCTONOESIS_FORK_DEPTH',
  'OCTONOESIS_FORK_MOCK',
]
beforeEach(async () => {
  originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'octo-background-')))
  await fs.writeFile(path.join(root, 'fact.txt'), 'APPENDED_FACT_99')
  process.env.OCTONOESIS_MEMORY_DIR = path.join(root, '.memory')
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  process.env.OCTONOESIS_COMPACT_THRESHOLD = '8000'
  for (const key of ['OCTONOESIS_DISABLE_COMPACT', 'OCTONOESIS_FORK_DEPTH', 'OCTONOESIS_FORK_MOCK'])
    Reflect.deleteProperty(process.env, key)
  originalSpawn = Bun.spawn
  originalMain = Bun.main
  Bun.main = path.resolve('src/cli.tsx')
  registerTool(readTool)
})
afterEach(async () => {
  setProvider(null)
  Bun.spawn = originalSpawn
  Bun.main = originalMain
  await flushJournal()
  await fs.rm(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(originalEnv)) restoreEnv(key, value)
})

function source(): CanonicalMessage[] {
  return [
    { role: 'user', content: 'Inspect the fixture; preserve EXACT_TASK' },
    { role: 'assistant', content: [{ type: 'text', text: 'old inspection '.repeat(1800) }] },
    { role: 'user', content: 'Keep earlier constraints' },
    { role: 'assistant', content: [{ type: 'text', text: 'old work' }] },
    { role: 'user', content: 'Continue inspection' },
    { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
  ]
}

function childGate() {
  let release!: () => void
  const exited = new Promise<number>((resolve) => {
    release = () => resolve(0)
  })
  let started = false
  let killed = false
  Bun.spawn = (...args: unknown[]) => {
    const options = args[0] as { cmd?: unknown }
    if (!Array.isArray(options?.cmd) || !options.cmd.includes('--fork-child'))
      return originalSpawn(...args)
    started = true
    return {
      pid: 987654,
      stdin: { write() {}, end() {} },
      stdout: new Blob([
        `${JSON.stringify({ text: 'Inspected fixture. EXACT_TASK remains required.', usage: { input_tokens: 5, output_tokens: 5 }, turns: 1, exitReason: 'completed' })}\n`,
      ]).stream(),
      stderr: new Blob([]).stream(),
      exited,
      kill() {
        killed = true
        release()
      },
    }
  }
  return {
    release,
    get started() {
      return started
    },
    get killed() {
      return killed
    },
  }
}

for (const finishEarly of [false, true])
  test(finishEarly
    ? 'cancels and reaps an unfinished summary on query completion without journaling an applied compact'
    : 'continues provider/tool work while summary runs and preserves the appended results at installation', async () => {
    const child = childGate()
    let calls = 0
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(messages) {
        calls++
        expect(child.started).toBe(true)
        if (calls === 1) {
          expect(JSON.stringify(messages)).not.toContain('<octo-compact-summary>')
          if (finishEarly) yield { type: 'text_delta', text: 'Done before summary finished' }
          else
            yield { type: 'tool_use', id: 'live-read', name: 'Read', input: { path: 'fact.txt' } }
        } else {
          expect(JSON.stringify(messages)).toContain('<octo-compact-summary>')
          expect(JSON.stringify(messages)).toContain('APPENDED_FACT_99')
          assertPairedHistory(messages)
          yield { type: 'text_delta', text: 'APPENDED_FACT_99 preserved' }
        }
        yield {
          type: 'message_end',
          stopReason: 'other',
          usage: { input_tokens: 2000, output_tokens: 10 },
        }
      },
    }
    setProvider(provider)
    const ctx = {
      repoRoot: root,
      messages: source(),
      config: parseConfig({
        maxTurns: 3,
        projectInstructions: 'off',
        compaction: { toolResultClearing: { enabled: false } },
      }),
    }
    const run = query('Read fact.txt, then finish.', ctx)
    let compacts = 0
    let step = await run.next()
    while (!step.done) {
      if (step.value.type === 'tool_done') {
        child.release()
        // Wait on actual child ownership, not a guessed frame delay.
        while (getActiveForkPids().length) await new Promise((resolve) => setTimeout(resolve, 1))
      }
      if (step.value.type === 'compact') compacts++
      step = await run.next()
    }
    expect(step.value.exit_reason).toBe('completed')
    expect(calls).toBe(finishEarly ? 1 : 2)
    expect(compacts).toBe(finishEarly ? 0 : 1)
    expect(child.killed).toBe(finishEarly)
    expect(getActiveForkPids()).toEqual([])
    const journal = (await fs.readFile(path.join(root, '.memory', 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(journal.filter((row) => row.kind === 'compact').length).toBe(compacts)
  })

test('waits for the pending summary at the hard threshold before sending another model request', async () => {
  const child = childGate()
  let calls = 0
  setProvider({
    name: 'anthropic',
    async *createMessageStream(messages) {
      calls++
      expect(JSON.stringify(messages)).toContain('<octo-compact-summary>')
      yield { type: 'text_delta', text: 'Done' }
      yield {
        type: 'message_end',
        stopReason: 'other',
        usage: { input_tokens: 100, output_tokens: 2 },
      }
    },
  })
  const messages = source()
  messages.splice(2, 0, {
    role: 'assistant',
    content: [{ type: 'text', text: 'extra context '.repeat(1000) }],
  })
  const run = query('Finish', {
    repoRoot: root,
    messages,
    config: parseConfig({ projectInstructions: 'off' }),
  })
  const first = run.next()
  while (!child.started) await new Promise((resolve) => setTimeout(resolve, 1))
  expect(calls).toBe(0)
  child.release()
  let step = await first
  expect(!step.done && step.value.type).toBe('compact')
  while (!step.done) step = await run.next()
  expect(calls).toBe(1)
  expect(step.value.exit_reason).toBe('completed')
})

test('supports a foreground-only configuration and rejects invalid early trigger ratios', async () => {
  const child = childGate()
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      expect(child.started).toBe(false)
      yield { type: 'text_delta', text: 'Done' }
      yield {
        type: 'message_end',
        stopReason: 'other',
        usage: { input_tokens: 100, output_tokens: 2 },
      }
    },
  })
  const run = query('Finish', {
    repoRoot: root,
    messages: source(),
    config: parseConfig({
      projectInstructions: 'off',
      compaction: { background: { enabled: false } },
    }),
  })
  let step = await run.next()
  while (!step.done) step = await run.next()
  expect(child.started).toBe(false)
  for (const triggerRatio of [0, 1, -0.1, 1.1])
    expect(() => parseConfig({ compaction: { background: { triggerRatio } } })).toThrow()
})

test('aborting an active query reaps its pending summary and leaves no applied compact event', async () => {
  const child = childGate()
  const controller = new AbortController()
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      expect(child.started).toBe(true)
      yield { type: 'text_delta', text: 'Working' }
      yield {
        type: 'message_end',
        stopReason: 'other',
        usage: { input_tokens: 2000, output_tokens: 2 },
      }
    },
  })
  const run = query(
    'Continue',
    { repoRoot: root, messages: source(), config: parseConfig({ projectInstructions: 'off' }) },
    controller.signal,
  )
  let step = await run.next()
  while (!step.done) {
    if (step.value.type === 'text_delta') controller.abort()
    step = await run.next()
  }
  expect(step.value.exit_reason).toBe('user_cancel')
  expect(child.killed).toBe(true)
  expect(getActiveForkPids()).toEqual([])
  const journal = await fs.readFile(path.join(root, '.memory', 'journal.jsonl'), 'utf8')
  expect(journal).not.toContain('"kind":"compact"')
})
