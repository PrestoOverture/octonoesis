// biome-ignore lint/suspicious/noExplicitAny: Bun.spawn is writable in the test runtime.
declare const Bun: any

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HookRegistry } from '../../../src/hooks/registry'
import { flushJournal } from '../../../src/memory/journal'
import { setProvider } from '../../../src/providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  ContentBlock,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
} from '../../../src/providers/types'
import {
  type QueryResult,
  type StreamEvent,
  checkBudget,
  initQueryState,
  isPromptTooLongError,
  maybeCompact,
  query,
  shouldStop,
} from '../../../src/query/engine'
import type { QueryLoopContext, QueryState } from '../../../src/query/types'

class ScriptedProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  calls = 0

  constructor(private readonly steps: Array<ProviderStreamEvent[] | Error>) {}

  async *createMessageStream(
    _messages: CanonicalMessage[],
    _tools: CanonicalTool[],
  ): AsyncIterable<ProviderStreamEvent> {
    const step = this.steps[this.calls]
    this.calls++
    if (step instanceof Error) throw step
    if (!step) throw new Error('Scripted provider exhausted')
    yield* step
  }
}

async function collectQuery(
  generator: AsyncGenerator<StreamEvent, QueryResult, undefined>,
): Promise<{ events: StreamEvent[]; result: QueryResult }> {
  const events: StreamEvent[] = []
  let step = await generator.next()
  while (!step.done) {
    events.push(step.value)
    step = await generator.next()
  }
  return { events, result: step.value }
}

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const originalDisableCompact = process.env.OCTONOESIS_DISABLE_COMPACT
const originalCompactThreshold = process.env.OCTONOESIS_COMPACT_THRESHOLD
const originalForkDepth = process.env.OCTONOESIS_FORK_DEPTH
let memoryDir = ''

beforeEach(async () => {
  memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-engine-unit-'))
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
  Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
})

afterEach(async () => {
  setProvider(null)
  await flushJournal()
  await fs.rm(memoryDir, { recursive: true, force: true })
  if (originalMemoryDir === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  } else {
    process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  }
  if (originalDisableCompact === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
  } else {
    process.env.OCTONOESIS_DISABLE_COMPACT = originalDisableCompact
  }
  if (originalCompactThreshold === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_COMPACT_THRESHOLD')
  } else {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = originalCompactThreshold
  }
  if (originalForkDepth === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
  } else {
    process.env.OCTONOESIS_FORK_DEPTH = originalForkDepth
  }
})

function makeState(overrides: Partial<QueryState> = {}): QueryState {
  return {
    turn: 2,
    messages: [],
    usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 15 },
    model: 'test-model',
    sessionId: 'session-1',
    repoRoot: '/repo',
    injectedRules: [],
    recordedRuleOutcomes: new Set(),
    tasks: new Map(),
    hooks: new HookRegistry(),
    ...overrides,
  }
}

describe('query engine', () => {
  it('stops only when the assistant response contains no tool use', () => {
    const textOnly: ContentBlock[] = [{ type: 'text', text: 'Finished.' }]
    const withTool: ContentBlock[] = [
      { type: 'text', text: 'I will inspect the file.' },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'src/query.ts' } },
    ]

    expect(shouldStop([])).toBe(true)
    expect(shouldStop(textOnly)).toBe(true)
    expect(shouldStop(withTool)).toBe(false)
  })

  it('returns budget_exceeded with exact cumulative usage after the budget is crossed', async () => {
    const state = makeState()

    const result = await checkBudget(state, { repoRoot: '/repo', tokenBudget: 64 })

    expect(result).toEqual({
      exit_reason: 'budget_exceeded',
      usage: state.usage,
      turns: 2,
    })
    expect(result && 'final_message' in result).toBe(false)
  })

  it('exits and journals budget_exceeded when cumulative usage crosses the budget mid-session', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'package.json' } },
        { type: 'message_end', usage: { input_tokens: 3, output_tokens: 2 } },
      ],
      [
        { type: 'tool_use', id: 'read-2', name: 'Read', input: { path: 'package.json' } },
        {
          type: 'message_end',
          usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 2 },
        },
      ],
    ])
    setProvider(provider)

    const { events, result } = await collectQuery(
      query('Read until the token budget is crossed', {
        repoRoot: process.cwd(),
        sessionId: 'budget-session',
        tokenBudget: 10,
      }),
    )

    expect(result).toEqual({
      exit_reason: 'budget_exceeded',
      usage: {
        input_tokens: 6,
        output_tokens: 3,
        cache_read_input_tokens: 2,
      },
      turns: 2,
    })
    expect(provider.calls).toBe(2)
    expect(
      events
        .filter((event) => event.type === 'tool_done')
        .map((event) => (event.type === 'tool_done' ? event.id : '')),
    ).toEqual(['read-1', 'read-2'])

    const rows = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const sessionRows = rows.filter(
      (row) => row.kind === 'session' && row.session_id === 'budget-session',
    )
    expect(sessionRows.length).toBe(1)
    expect(sessionRows[0]?.kind).toBe('session')
    expect(sessionRows[0]?.schema_version).toBe(1)
    expect(sessionRows[0]?.exit_reason).toBe('budget_exceeded')
    expect(sessionRows[0]?.usage).toEqual({ input_tokens: 6, output_tokens: 3 })
    expect(sessionRows[0]?.session_id).toBe('budget-session')
    expect(typeof sessionRows[0]?.model).toBe('string')
    expect(typeof sessionRows[0]?.ts).toBe('string')
  })

  it('does not enforce a token budget when none is configured', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_use', id: 'read-high', name: 'Read', input: { path: 'package.json' } },
        { type: 'message_end', usage: { input_tokens: 50_000, output_tokens: 2 } },
      ],
      [
        { type: 'text_delta', text: 'Finished without an implicit budget.' },
        { type: 'message_end', usage: { input_tokens: 20_000, output_tokens: 1 } },
      ],
    ])
    setProvider(provider)

    const { result } = await collectQuery(
      query('Continue despite high billed usage', {
        repoRoot: process.cwd(),
        sessionId: 'unlimited-session',
      }),
    )

    expect(result.exit_reason).toBe('completed')
    expect(result.turns).toBe(2)
    expect(result.usage).toEqual({ input_tokens: 70_000, output_tokens: 3 })
    expect(result.final_message).toBe('Finished without an implicit budget.')
    expect(provider.calls).toBe(2)
  })

  it('returns completed with the final message before checking a terminal-turn budget', async () => {
    setProvider(
      new ScriptedProvider([
        [
          { type: 'text_delta', text: 'This response finishes the task.' },
          { type: 'message_end', usage: { input_tokens: 5, output_tokens: 2 } },
        ],
      ]),
    )

    const { result } = await collectQuery(
      query('Finish above the configured budget', {
        repoRoot: process.cwd(),
        sessionId: 'terminal-budget-session',
        tokenBudget: 6,
      }),
    )

    expect(result).toEqual({
      exit_reason: 'completed',
      usage: { input_tokens: 5, output_tokens: 2 },
      turns: 1,
      final_message: 'This response finishes the task.',
    })
  })

  it('classifies and journals a context-window streaming error as prompt_too_long', async () => {
    const errorMessage = 'maximum context length exceeded by 123 tokens'
    setProvider(new ScriptedProvider([new Error(errorMessage)]))

    const { result } = await collectQuery(
      query('Trigger the reactive prompt limit path', {
        repoRoot: process.cwd(),
        sessionId: 'prompt-limit-session',
      }),
    )

    expect(result).toEqual({
      exit_reason: 'prompt_too_long',
      usage: { input_tokens: 0, output_tokens: 0 },
      turns: 1,
      error: errorMessage,
    })

    const rows = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const sessionRows = rows.filter(
      (row) => row.kind === 'session' && row.session_id === 'prompt-limit-session',
    )
    expect(sessionRows.length).toBe(1)
    expect(sessionRows[0]?.exit_reason).toBe('prompt_too_long')
    expect(sessionRows[0]?.schema_version).toBe(1)
  })

  it('recognizes every supported prompt-length error spelling', () => {
    expect(isPromptTooLongError(new Error('Prompt is too long for this model'))).toBe(true)
    expect(isPromptTooLongError(new Error('Maximum context length reached'))).toBe(true)
    expect(isPromptTooLongError('context_length_exceeded')).toBe(true)
    expect(isPromptTooLongError(new Error('Provider connection closed'))).toBe(false)
  })

  it('keeps unrelated streaming failures classified as fatal_error', async () => {
    const errorMessage = 'provider connection closed unexpectedly'
    setProvider(new ScriptedProvider([new Error(errorMessage)]))

    const { result } = await collectQuery(
      query('Trigger an unrelated provider failure', {
        repoRoot: process.cwd(),
        sessionId: 'fatal-session',
      }),
    )

    expect(result).toEqual({
      exit_reason: 'fatal_error',
      usage: { input_tokens: 0, output_tokens: 0 },
      turns: 1,
      error: errorMessage,
    })

    const rows = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const sessionRow = rows.find(
      (row) => row.kind === 'session' && row.session_id === 'fatal-session',
    )
    expect(sessionRow?.exit_reason).toBe('fatal_error')
  })

  it('keeps live state aliases and replaces both message references during compaction', async () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: `Old request ${'detail '.repeat(200)}` },
      {
        role: 'assistant',
        content: [{ type: 'text', text: `Older response ${'context '.repeat(200)}` }],
      },
      { role: 'user', content: 'Additional older request' },
      { role: 'assistant', content: [{ type: 'text', text: 'Recent response one' }] },
      { role: 'user', content: 'Recent request two' },
      { role: 'assistant', content: [{ type: 'text', text: 'Recent response three' }] },
    ]
    const injectedRules: NonNullable<QueryLoopContext['injectedRules']> = []
    const recordedRuleOutcomes = new Set<string>()
    const ctx: QueryLoopContext = {
      repoRoot: process.cwd(),
      sessionId: 'alias-session',
      messages,
      injectedRules,
      recordedRuleOutcomes,
    }
    const state = await initQueryState('Continue after compaction', ctx)

    expect(state.messages).toBe(messages)
    expect(state.injectedRules).toBe(injectedRules)
    expect(state.recordedRuleOutcomes).toBe(recordedRuleOutcomes)

    process.env.OCTONOESIS_COMPACT_THRESHOLD = '10'
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
    const originalSpawn = Bun.spawn
    Bun.spawn = () => ({
      pid: 991_027,
      stdin: { write: () => {}, end: async () => {} },
      stdout: new Blob([
        `${JSON.stringify({
          text: 'Dense compact summary.',
          usage: { input_tokens: 5, output_tokens: 2 },
          turns: 1,
          exitReason: 'completed',
        })}\n`,
      ]).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve(0),
      kill: () => {},
    })

    try {
      const readyState = Object.assign(state, {
        provider: new ScriptedProvider([]),
        system: 'byte-identical system prompt',
        dynamicSystem: 'first-turn dynamic system',
        tools: [] as CanonicalTool[],
      })
      const events: StreamEvent[] = []
      const generator = maybeCompact(readyState, ctx)
      let step = await generator.next()
      while (!step.done) {
        events.push(step.value)
        step = await generator.next()
      }

      expect(step.value).toBe('proceed')
      expect(events.length).toBe(1)
      expect(events[0]?.type).toBe('compact')
      expect(state.messages).toBe(ctx.messages)
      expect(state.messages).not.toBe(messages)
      expect(state.messages[0]).toEqual(messages[0])
      expect(JSON.stringify(state.messages[1])).toContain('<octo-compact-summary>')
      expect(JSON.stringify(state.messages[1])).toContain('Dense compact summary.')
      expect(state.compactBoundary).toBe(2)
      expect(state.compactConsecutiveFailures).toBe(0)
      expect(state.compactCircuitOpen).toBe(false)
    } finally {
      Bun.spawn = originalSpawn
    }
  })
})
