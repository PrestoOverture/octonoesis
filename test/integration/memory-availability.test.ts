import { afterEach, beforeEach, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { extractMemories } from '../../src/memory/auto/extract'
import { findRelevantMemories } from '../../src/memory/auto/recall'
import {
  initializeMemoryAvailability,
  markMemoryAvailability,
  probeMemoryDir,
  resetMemoryAvailability,
} from '../../src/memory/availability'
import {
  flushJournal,
  getJournalWriteFailureCount,
  resetJournalWriteFailures,
} from '../../src/memory/journal'
import { runSessionEndAutoDistill } from '../../src/memory/rules/autoDistill'
import { loadRule, saveRule } from '../../src/memory/rules/store'
import type { RuleFile } from '../../src/memory/rules/types'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../src/permissions/confirm'
import { buildSessionContextSources } from '../../src/prompts/context'
import { setProvider } from '../../src/providers'
import { initQueryState, query, runQuery } from '../../src/query/engine'
import type { QueryLoopContext } from '../../src/query/types'
import { App } from '../../src/ui/App'
import { restoreEnv } from '../helpers/env'

const originals = Object.fromEntries(
  ['OCTONOESIS_MEMORY_DIR', 'OCTONOESIS_REPO_ROOT', 'OCTONOESIS_DISABLE_MEMORY'].map((key) => [
    key,
    process.env[key],
  ]),
)
let root = ''
let dir = ''
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-availability-'))
  dir = path.join(root, 'memory')
  process.env.OCTONOESIS_MEMORY_DIR = dir
  process.env.OCTONOESIS_REPO_ROOT = root
  restoreEnv('OCTONOESIS_DISABLE_MEMORY', undefined)
  resetMemoryAvailability()
  resetJournalWriteFailures()
})
afterEach(async () => {
  await flushJournal()
  resetMemoryAvailability()
  resetJournalWriteFailures()
  setProvider(null)
  for (const [key, value] of Object.entries(originals)) restoreEnv(key, value)
  await fs.rm(root, { recursive: true, force: true })
})

it('creates a missing directory and leaves no probe in a writable directory', async () => {
  expect(await probeMemoryDir(dir)).toEqual({ usable: true })
  expect((await fs.stat(dir)).isDirectory()).toBe(true)
  expect(await probeMemoryDir(dir)).toEqual({ usable: true })
  expect(await fs.readdir(dir)).toEqual([])
})

it('reports errno for a path under a regular file and a regular file at the path', async () => {
  await fs.writeFile(dir, '')
  expect(await probeMemoryDir(path.join(dir, 'child'))).toEqual({
    usable: false,
    dir: path.join(dir, 'child'),
    code: 'ENOTDIR',
  })
  const result = await probeMemoryDir(dir)
  expect(result.usable).toBe(false)
  if (!result.usable) expect(result.code).toBe('EEXIST')
})

it('completes runQuery with unavailable memory and prints each notice once', async () => {
  await fs.writeFile(dir, '')
  dir = path.join(dir, 'child')
  process.env.OCTONOESIS_MEMORY_DIR = dir
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield { type: 'text_delta', text: 'Done.' }
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  const originalError = console.error
  const lines: string[] = []
  console.error = (...args: unknown[]) => {
    lines.push(String(args[0]))
  }
  try {
    await initializeMemoryAvailability(dir)
    await runQuery('complete this task')
    expect(
      lines.filter(
        (line) =>
          line ===
          `⚠ Memory dir unusable: ${dir} (ENOTDIR) — running without memory (rules, recall, auto-memory off)`,
      ).length,
    ).toBe(1)
    expect(
      lines.filter((line) => line === `⚠ Memory was off this session: ${dir} (ENOTDIR)`).length,
    ).toBe(1)
    expect(getJournalWriteFailureCount()).toBeGreaterThan(0)
  } finally {
    console.error = originalError
  }
})

const rule: RuleFile = {
  id: 'rule-availability',
  triggers: { tools: ['Bash'], command_prefix: [], error_signatures: ['bun-test|TypeError'] },
  scope: 'repo',
  alpha: 3,
  beta: 2,
  confidence: 0.6,
  evidence: ['ep_0001'],
  hits: 0,
  misses: 0,
  challenged_by: [],
  anchor: { file: 'package.json' },
  status: 'active',
  user_confirmed: false,
  extractor_version: '0.2.0',
  model_id: 'mock',
  prompt_hash: 'hash',
  created_at: new Date().toISOString(),
  last_matched_at: null,
  last_rebuilt_at: null,
  advice: 'availability advice',
}

it('gates context, recall, extraction, distillation, rules and experiment assignment while unavailable', async () => {
  await fs.writeFile(dir, '')
  markMemoryAvailability({ usable: false, dir, code: 'EEXIST' })
  const memory = {
    name: 'test',
    description: 'test',
    type: 'user' as const,
    content: 'test',
    path: 'test',
    mtime: 0,
  }
  const ctx = { repoRoot: root }
  const sources = await buildSessionContextSources(
    ctx,
    'mock',
    { input_tokens: 0, output_tokens: 0 },
    [memory],
    [],
    [rule],
  )
  expect(sources.map((source) => source.id)).not.toContain('memory_index')
  expect(sources.map((source) => source.id)).not.toContain('active_rules')
  expect(sources.map((source) => source.id)).not.toContain('relevant_memories')
  let forkCalls = 0
  const forkFn = async (): Promise<never> => {
    forkCalls++
    throw new Error('must not fork')
  }
  expect(await findRelevantMemories('test', [memory], { forkFn })).toEqual([])
  await extractMemories(
    {
      system: '',
      messages: Array.from({ length: 4 }, () => ({ role: 'user' as const, content: 'test' })),
    },
    ctx,
    { forkFn },
  )
  expect(forkCalls).toBe(0)
  await runSessionEndAutoDistill('test', root)
  const state = await initQueryState('test', ctx)
  expect(state.rules).toEqual([])
  expect('experimentArm' in ctx).toBe(false)
})

it('does not load rules when only DISABLE_MEMORY is set and the directory is usable', async () => {
  await saveRule(rule, path.join(dir, 'rules'))
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  expect(await probeMemoryDir(dir)).toEqual({ usable: true })
  const state = await initQueryState('test', { repoRoot: root })
  expect(state.rules).toEqual([])
})

it('starts the TUI and accepts a prompt when history and session storage are unusable', async () => {
  await fs.writeFile(dir, '')
  dir = path.join(dir, 'child')
  process.env.OCTONOESIS_MEMORY_DIR = dir
  const originalError = console.error
  console.error = () => {}
  let calls = 0
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      calls++
      yield { type: 'text_delta', text: 'TUI task completed' }
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  await initializeMemoryAvailability(dir)
  const view = render(
    React.createElement(App, {
      ctx: { repoRoot: root, memoryDir: dir, persistSession: true, messages: [], tasks: new Map() },
    }),
  )
  try {
    view.stdin.write('complete TUI task')
    await new Promise((resolve) => setTimeout(resolve, 20))
    view.stdin.write('\r')
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !view.lastFrame()?.includes('TUI task completed')) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(view.lastFrame()).toContain('TUI task completed')
    expect(calls).toBe(1)
  } finally {
    view.unmount()
    console.error = originalError
  }
})

for (const disabled of [true, false]) {
  it(`FR-INJ-1 ${disabled ? 'suppresses injection and accounting with DISABLE_MEMORY' : 'injects and records a hit with memory enabled'}`, async () => {
    const rulesDir = path.join(dir, 'rules')
    await saveRule(rule, rulesDir)
    const rulePath = path.join(rulesDir, `${rule.id}.md`)
    const before = await fs.readFile(rulePath, 'utf8')
    if (disabled) process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    await fs.writeFile(
      path.join(root, 'regression.test.ts'),
      `import { test } from 'bun:test'
import { existsSync } from 'node:fs'
test('verification', () => {
  if (!existsSync('fixed')) throw new TypeError('memory flag regression')
})
`,
    )
    let turn = 0
    setProvider({
      name: 'anthropic',
      async *createMessageStream(messages) {
        if (
          JSON.stringify(messages[0]?.content).includes('precise tool execution error analyzer')
        ) {
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              tool: 'bun-test',
              error_class: 'TypeError',
              file: 'regression.test.ts',
              expression: 'memory flag regression',
            }),
          }
        } else {
          turn++
          if (turn === 1 || turn === 3) {
            yield {
              type: 'tool_use',
              id: `verify-${turn}`,
              name: 'Bash',
              input: { command: 'bun test' },
            }
          } else if (turn === 2) {
            yield {
              type: 'tool_use',
              id: 'fix',
              name: 'Write',
              input: { path: 'fixed', content: 'fixed' },
            }
          } else {
            yield { type: 'text_delta', text: 'Done.' }
          }
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })
    clearAllowlist()
    registerPromptHandler(async () => 'allow_always')
    const ctx: QueryLoopContext = { repoRoot: await fs.realpath(root), messages: [] }
    try {
      for await (const _event of query('Fix the verification failure', ctx)) {
      }
      expect(turn).toBe(4)
      const failure = ctx.messages?.find(
        (message) => message.role === 'tool' && message.tool_use_id === 'verify-1',
      )
      expect(failure).toBeDefined()
      if (failure?.role !== 'tool') throw new Error('missing failing Bash result')
      const failureContent =
        typeof failure.content === 'string' ? failure.content : JSON.stringify(failure.content)
      const verification = ctx.messages?.find(
        (message) => message.role === 'tool' && message.tool_use_id === 'verify-3',
      )
      expect(verification).toBeDefined()
      if (verification?.role !== 'tool' || typeof verification.content !== 'string')
        throw new Error('missing verification result')
      expect(JSON.parse(verification.content).code).toBe(0)
      expect(failureContent).toContain('TypeError')
      if (disabled) {
        expect(failureContent).not.toContain('<octo-memory>')
        expect(await fs.readFile(rulePath, 'utf8')).toBe(before)
      } else {
        expect(failureContent).toContain('<octo-memory>')
        expect(failureContent).toContain(rule.advice)
        const updated = await loadRule(rule.id, rulesDir)
        expect(updated?.hits).toBe(1)
        expect(updated?.misses).toBe(0)
        expect(updated?.alpha).toBe(rule.alpha + 1)
        expect(updated?.beta).toBe(rule.beta)
      }
      expect(ctx._lastVerifyResultForQuery).toBeUndefined()
    } finally {
      unregisterPromptHandler()
      clearAllowlist()
    }
  })
}
