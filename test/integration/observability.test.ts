// biome-ignore lint/suspicious/noExplicitAny: Bun.main and Bun.spawn are writable in tests.
declare const Bun: any

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setProvider } from '../../src/providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
} from '../../src/providers/types'
import { type QueryResult, type StreamEvent, query, runQuery } from '../../src/query'
import type { SessionState } from '../../src/query/types'
import { createSessionState, flushSessionStats } from '../../src/state/session'
import { estimateCost } from '../../src/utils/cost'

class TwoTurnProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  private turn = 0

  async *createMessageStream(
    _messages: CanonicalMessage[],
    _tools: CanonicalTool[],
  ): AsyncIterable<ProviderStreamEvent> {
    this.turn++
    if (this.turn === 1) {
      yield { type: 'tool_use', id: 'observe-read', name: 'Read', input: { path: 'package.json' } }
      yield {
        type: 'message_end',
        usage: {
          input_tokens: 50_000,
          output_tokens: 5_000,
          cache_read_input_tokens: 10_000,
          cache_creation_input_tokens: 5_000,
        },
      }
      return
    }

    yield { type: 'text_delta', text: 'Observed.' }
    yield { type: 'message_end', usage: { input_tokens: 90_000, output_tokens: 8_000 } }
  }
}

class FinalOnlyProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  private call = 0

  async *createMessageStream(): AsyncIterable<ProviderStreamEvent> {
    this.call++
    yield { type: 'text_delta', text: `Done ${this.call}.` }
    yield {
      type: 'message_end',
      usage: { input_tokens: this.call * 1_000, output_tokens: this.call * 100 },
    }
  }
}

class CompactingProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  private turn = 0

  async *createMessageStream(): AsyncIterable<ProviderStreamEvent> {
    this.turn++
    if (this.turn <= 3) {
      yield {
        type: 'tool_use',
        id: `compact-read-${this.turn}`,
        name: 'Read',
        input: { path: 'package.json' },
      }
      yield { type: 'message_end', usage: { input_tokens: 5_000, output_tokens: 10 } }
      return
    }
    yield { type: 'text_delta', text: 'Compacted.' }
    yield { type: 'message_end', usage: { input_tokens: 100, output_tokens: 10 } }
  }
}

interface SessionStateEvent {
  type: 'session_state'
  sessionState: SessionState
  priced: boolean
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

describe('session observability integration', () => {
  const originalEnv = {
    memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
    model: process.env.MODEL,
    disableCompact: process.env.OCTONOESIS_DISABLE_COMPACT,
    disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
    compactThreshold: process.env.OCTONOESIS_COMPACT_THRESHOLD,
    forkDepth: process.env.OCTONOESIS_FORK_DEPTH,
  }
  let tempDir = ''
  let repoRoot = ''

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-observability-'))
    repoRoot = path.join(tempDir, 'repo')
    await fs.mkdir(repoRoot, { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'package.json'), '{"name":"observe"}', 'utf8')
    process.env.OCTONOESIS_MEMORY_DIR = path.join(tempDir, 'state')
    process.env.MODEL = 'claude-haiku-4-5-observability'
    process.env.OCTONOESIS_DISABLE_COMPACT = '1'
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    setProvider(new TwoTurnProvider())
  })

  afterEach(async () => {
    setProvider(null)
    await flushSessionStats()
    await fs.rm(tempDir, { recursive: true, force: true })
    for (const [key, value] of Object.entries({
      OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
      MODEL: originalEnv.model,
      OCTONOESIS_DISABLE_COMPACT: originalEnv.disableCompact,
      OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
      OCTONOESIS_COMPACT_THRESHOLD: originalEnv.compactThreshold,
      OCTONOESIS_FORK_DEPTH: originalEnv.forkDepth,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })

  it('emits cumulative copied session snapshots and persists the final totals', async () => {
    const sessionId = 'observable-session'
    const { events, result } = await collectQuery(
      query('Inspect the fixture', {
        repoRoot,
        sessionId,
        sessionState: createSessionState(sessionId, 'claude-haiku-4-5-observability'),
      }),
    )
    const sessionEvents = events
      .filter((event) => (event as { type: string }).type === 'session_state')
      .map((event) => event as unknown as SessionStateEvent)

    expect(result.exit_reason).toBe('completed')
    expect(sessionEvents.length).toBe(2)
    expect(sessionEvents[0]?.sessionState.turns).toBe(1)
    expect(sessionEvents[0]?.sessionState.usage).toEqual({
      input_tokens: 50_000,
      output_tokens: 5_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 5_000,
    })
    expect(sessionEvents[1]?.sessionState.turns).toBe(2)
    expect(sessionEvents[1]?.sessionState.usage).toEqual({
      input_tokens: 140_000,
      output_tokens: 13_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 5_000,
    })
    const expectedCost = estimateCost(
      sessionEvents[1]?.sessionState.usage ?? { input_tokens: 0, output_tokens: 0 },
      'claude-haiku-4-5-observability',
    ).costUsd
    expect(sessionEvents[1]?.sessionState.costUsd).toBe(expectedCost)
    expect(Number(expectedCost.toFixed(2))).toBe(0.17)
    expect(sessionEvents.every((event) => event.priced)).toBe(true)
    expect(
      sessionEvents.every(
        (event) =>
          event.sessionState.contextUtilization > 0 && event.sessionState.contextUtilization <= 1,
      ),
    ).toBe(true)

    await flushSessionStats()
    const rows = (await fs.readFile(path.join(tempDir, 'state', 'stats.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.length).toBe(1)
    expect(rows[0]?.turns).toBe(sessionEvents[1]?.sessionState.turns)
    expect(rows[0]?.usage).toEqual(sessionEvents[1]?.sessionState.usage)
    expect(rows[0]?.cost_usd).toBe(sessionEvents[1]?.sessionState.costUsd)
    expect(rows[0]?.context_utilization).toBe(sessionEvents[1]?.sessionState.contextUtilization)
  })

  it('keeps one cumulative session state across successive TUI-style queries', async () => {
    setProvider(new FinalOnlyProvider())
    const sessionId = 'long-lived-tui-session'
    const ctx = {
      repoRoot,
      sessionId,
      messages: [] as CanonicalMessage[],
      sessionState: createSessionState(sessionId, 'claude-haiku-4-5-observability'),
    }

    const first = await collectQuery(query('First request', ctx))
    const second = await collectQuery(query('Second request', ctx))
    const firstSnapshot = first.events.find(
      (event) => (event as { type: string }).type === 'session_state',
    ) as unknown as SessionStateEvent
    const secondSnapshot = second.events.find(
      (event) => (event as { type: string }).type === 'session_state',
    ) as unknown as SessionStateEvent

    expect(firstSnapshot.sessionState.turns).toBe(1)
    expect(secondSnapshot.sessionState.turns).toBe(2)
    expect(secondSnapshot.sessionState.usage).toEqual({
      input_tokens: 3_000,
      output_tokens: 300,
    })
    expect(secondSnapshot.sessionState.startTime).toBe(firstSnapshot.sessionState.startTime)

    await flushSessionStats()
    const rows = (await fs.readFile(path.join(tempDir, 'state', 'stats.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.map((row) => row.session_id)).toEqual([
      'long-lived-tui-session',
      'long-lived-tui-session',
    ])
    expect(rows.at(-1)?.turns).toBe(2)
    expect(rows.at(-1)?.usage).toEqual(secondSnapshot.sessionState.usage)
  })

  it('counts compaction and its fork usage in the following session snapshot', async () => {
    const originalMain = Bun.main
    const originalSpawn = Bun.spawn
    Bun.main = path.resolve('src/cli.tsx')
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
    Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
    Bun.spawn = (...args: unknown[]) => {
      const options = args[0] as { cmd?: unknown } | undefined
      if (!Array.isArray(options?.cmd) || !options.cmd.includes('--fork-child')) {
        return originalSpawn(...args)
      }
      return {
        pid: 291_001,
        stdin: { write: () => {}, end: async () => {} },
        stdout: new Blob([
          `${JSON.stringify({
            text: 'Compact observability summary.',
            usage: { input_tokens: 7, output_tokens: 3 },
            turns: 1,
            exitReason: 'completed',
          })}\n`,
        ]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => {},
      }
    }
    setProvider(new CompactingProvider())

    try {
      const { events, result } = await collectQuery(
        query('Exercise observable compaction', {
          repoRoot,
          sessionId: 'observable-compact-session',
          sessionState: createSessionState(
            'observable-compact-session',
            'claude-haiku-4-5-observability',
          ),
        }),
      )
      const sessionEvents = events
        .filter((event) => (event as { type: string }).type === 'session_state')
        .map((event) => event as unknown as SessionStateEvent)
      const compactIndex = events.findIndex(
        (event) => (event as { type: string }).type === 'compact',
      )
      const postCompact = events[compactIndex + 1] as unknown as SessionStateEvent
      const finalSnapshot = sessionEvents.at(-1)?.sessionState

      expect(result.exit_reason).toBe('completed')
      expect(compactIndex).toBeGreaterThan(-1)
      expect(postCompact.type).toBe('session_state')
      expect(postCompact.sessionState.compactCount).toBe(1)
      expect(postCompact.sessionState.usage).toEqual({ input_tokens: 15_007, output_tokens: 33 })
      expect(postCompact.sessionState.contextUtilization).toBeLessThan(
        sessionEvents[1]?.sessionState.contextUtilization ?? 0,
      )
      expect(finalSnapshot?.turns).toBe(4)
      expect(finalSnapshot?.compactCount).toBe(1)
      expect(finalSnapshot?.usage).toEqual({ input_tokens: 15_107, output_tokens: 43 })

      await flushSessionStats()
      const finalRow = (await fs.readFile(path.join(tempDir, 'state', 'stats.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .at(-1)
      expect(finalRow?.compact_count).toBe(finalSnapshot?.compactCount)
      expect(finalRow?.usage).toEqual(finalSnapshot?.usage)
    } finally {
      Bun.main = originalMain
      Bun.spawn = originalSpawn
    }
  })

  it('ends one-shot stdout with the shared session summary line', async () => {
    setProvider(new FinalOnlyProvider())
    const writes: string[] = []
    const originalWrite = process.stdout.write
    process.stdout.write = (chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
      return true
    }

    try {
      await runQuery('Show the one-shot summary')
    } finally {
      process.stdout.write = originalWrite
    }

    expect(
      /Session summary: 1 turns \| in: 1,000 \| out: 100 \| cost: \$0\.0012 \| compactions: 0\n?$/.test(
        writes.join(''),
      ),
    ).toBe(true)
  })
})
