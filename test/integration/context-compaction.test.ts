// biome-ignore lint/suspicious/noExplicitAny: Bun.main is writable in the test runtime.
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
import { contextTokensWithEstimation } from '../../src/utils/tokens'

const cliPath = path.resolve('src/cli.tsx')
const compactSummary =
  'The user requested a long repository inspection. Turns 1-10 read package.json; FACT_ALPHA remains relevant.'

class RecordingProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  readonly calls: CanonicalMessage[][] = []
  private turn = 0

  async *createMessageStream(
    messages: CanonicalMessage[],
    _tools: CanonicalTool[],
  ): AsyncIterable<ProviderStreamEvent> {
    this.calls.push(structuredClone(messages))
    this.turn++

    if (this.turn <= 15) {
      yield {
        type: 'tool_use',
        id: `read-${this.turn}`,
        name: 'Read',
        input: { path: 'package.json' },
      }
      yield {
        type: 'message_end',
        usage:
          this.turn === 12
            ? {
                input_tokens: 1_000,
                output_tokens: 10,
                cache_read_input_tokens: 3_500,
              }
            : { input_tokens: 100, output_tokens: 10 },
      }
      return
    }

    yield { type: 'text_delta', text: 'Completed after preserving FACT_ALPHA.' }
    yield { type: 'message_end', usage: { input_tokens: 100, output_tokens: 10 } }
  }
}

class ScheduledProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  readonly calls: CanonicalMessage[][] = []
  private turn = 0

  constructor(
    private readonly toolTurns: number,
    private readonly onProviderCall?: (turn: number) => void,
  ) {}

  async *createMessageStream(
    messages: CanonicalMessage[],
    _tools: CanonicalTool[],
  ): AsyncIterable<ProviderStreamEvent> {
    this.calls.push(structuredClone(messages))
    this.turn++
    this.onProviderCall?.(this.turn)

    if (this.turn <= this.toolTurns) {
      yield {
        type: 'tool_use',
        id: `scheduled-read-${this.turn}`,
        name: 'Read',
        input: { path: 'package.json' },
      }
      yield { type: 'message_end', usage: { input_tokens: 5_000, output_tokens: 10 } }
      return
    }

    yield { type: 'text_delta', text: 'Scheduled session complete.' }
    yield { type: 'message_end', usage: { input_tokens: 100, output_tokens: 10 } }
  }
}

function assertValidMessageHistory(messages: CanonicalMessage[]): void {
  expect(messages[0]?.role).toBe('user')
  const seenToolUses = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool_use') seenToolUses.add(block.id)
      }
    } else if (message.role === 'tool') {
      expect(seenToolUses.has(message.tool_use_id)).toBe(true)
    }
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

describe('context auto-compression integration', () => {
  const originalEnv = {
    memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
    threshold: process.env.OCTONOESIS_COMPACT_THRESHOLD,
    disable: process.env.OCTONOESIS_DISABLE_COMPACT,
    forkMock: process.env.OCTONOESIS_FORK_MOCK,
    forkDepth: process.env.OCTONOESIS_FORK_DEPTH,
  }
  let originalMain: string
  let originalSpawn: (...args: unknown[]) => unknown
  let memoryDir: string

  beforeEach(async () => {
    originalMain = Bun.main
    originalSpawn = Bun.spawn
    Bun.main = cliPath
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-compact-integration-'))
    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '4000'
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({ text: compactSummary })
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
    Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
  })

  afterEach(async () => {
    setProvider(null)
    Bun.main = originalMain
    Bun.spawn = originalSpawn
    await fs.rm(memoryDir, { recursive: true, force: true })
    for (const [key, value] of Object.entries({
      OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
      OCTONOESIS_COMPACT_THRESHOLD: originalEnv.threshold,
      OCTONOESIS_DISABLE_COMPACT: originalEnv.disable,
      OCTONOESIS_FORK_MOCK: originalEnv.forkMock,
      OCTONOESIS_FORK_DEPTH: originalEnv.forkDepth,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })

  it('compacts once during a 16-turn session and continues with valid summarized history', async () => {
    const provider = new RecordingProvider()
    setProvider(provider)

    const { events, result } = await collectQuery(
      query('Inspect this repository over many turns', { repoRoot: process.cwd() }),
    )
    const compactEvents = events.filter(
      (event): event is Extract<StreamEvent, { type: 'compact' }> => event.type === 'compact',
    )

    expect(result.exit_reason).toBe('completed')
    expect(result.turns).toBe(16)
    expect(compactEvents.length).toBe(1)
    const compactEvent = compactEvents[0]
    expect(compactEvent).toBeDefined()
    if (!compactEvent) return
    expect(compactEvent.preTokens).toBeGreaterThan(4_000)
    expect(compactEvent.postTokens).toBeLessThan(compactEvent.preTokens)
    expect(Number.isFinite(compactEvent.durationMs)).toBe(true)
    expect(compactEvent.durationMs).toBeGreaterThan(-1)

    const postCompactMessages = provider.calls[12]
    expect(postCompactMessages).toBeDefined()
    if (!postCompactMessages) return
    assertValidMessageHistory(postCompactMessages)
    expect(contextTokensWithEstimation(postCompactMessages)).toBe(compactEvent.postTokens)
    expect(postCompactMessages.length).toBe(6)
    expect(postCompactMessages[0]).toEqual(provider.calls[0]?.[0])
    expect(JSON.stringify(postCompactMessages[0])).toContain(
      'Inspect this repository over many turns',
    )
    expect(JSON.stringify(postCompactMessages[1])).toContain('<octo-compact-summary>')
    expect(JSON.stringify(postCompactMessages[1])).toContain('FACT_ALPHA')
    expect(postCompactMessages[2]?.role).toBe('assistant')
    expect(JSON.stringify(postCompactMessages[2])).toContain('read-11')
    expect(postCompactMessages[3]?.role).toBe('tool')
    if (postCompactMessages[3]?.role === 'tool') {
      expect(postCompactMessages[3].tool_use_id).toBe('read-11')
    }
    expect(JSON.stringify(postCompactMessages[4])).toContain('read-12')
    expect(postCompactMessages[5]?.role).toBe('tool')
    if (postCompactMessages[5]?.role === 'tool') {
      expect(postCompactMessages[5].tool_use_id).toBe('read-12')
    }
    expect(JSON.stringify(provider.calls[13])).toContain('FACT_ALPHA')

    const journal = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const compactRows = journal.filter((row) => row.kind === 'compact')
    expect(compactRows.length).toBe(1)
    expect(compactRows[0]?.schema_version).toBe(2)
    expect(compactRows[0]?.pre_tokens).toBe(compactEvent.preTokens)
    expect(compactRows[0]?.post_tokens).toBe(compactEvent.postTokens)
    expect(compactRows[0]?.summary_length).toBe(compactSummary.length)
  })

  it('continues a mock session with the verbatim original request pinned at index zero', async () => {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({
      text: 'Fictional Phase 29 review task invented by the summarizer.',
    })
    const provider = new ScheduledProvider(3)
    setProvider(provider)
    const originalRequest = 'Audit exactly twenty source files and report each risk level.'

    const { events, result } = await collectQuery(
      query(originalRequest, { repoRoot: process.cwd() }),
    )

    expect(result.exit_reason).toBe('completed')
    expect(events.some((event) => event.type === 'compact')).toBe(true)
    const postCompactMessages = provider.calls.find((messages) =>
      JSON.stringify(messages).includes('Fictional Phase 29 review task'),
    )
    expect(postCompactMessages?.[0]).toEqual(provider.calls[0]?.[0])
    expect(JSON.stringify(postCompactMessages?.[0])).toContain(originalRequest)
    expect(JSON.stringify(postCompactMessages?.[1])).toContain('<octo-compact-summary>')
  })

  it('leaves history intact and opens the circuit after three consecutive fork failures', async () => {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
    process.env.OCTONOESIS_FORK_MOCK = '{invalid-json'
    let forkSpawnCount = 0
    Bun.spawn = (...args: unknown[]) => {
      const options = args[0] as { cmd?: unknown } | undefined
      if (Array.isArray(options?.cmd) && options.cmd.includes('--fork-child')) forkSpawnCount++
      return originalSpawn(...args)
    }
    const provider = new ScheduledProvider(6, (turn) => {
      if (turn === 6) {
        process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({ text: 'would succeed' })
      }
    })
    setProvider(provider)
    const ctx = { repoRoot: process.cwd(), messages: [] as CanonicalMessage[] }

    const { events, result } = await collectQuery(query('Keep the original history', ctx))

    expect(result.exit_reason).toBe('completed')
    expect(result.turns).toBe(7)
    expect(forkSpawnCount).toBe(3)
    expect(events.some((event) => event.type === 'compact')).toBe(false)
    expect(ctx.messages.length).toBe(14)
    expect(JSON.stringify(ctx.messages)).not.toContain('<octo-compact-summary>')
    expect(ctx.messages[0]?.role).toBe('user')
    expect(JSON.stringify(ctx.messages)).toContain('scheduled-read-1')
    expect(JSON.stringify(ctx.messages)).toContain('scheduled-read-6')
  })

  it('skips a threshold-crossing prefix-empty history without counting a failure', async () => {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
    process.env.OCTONOESIS_FORK_MOCK = '{invalid-json'
    let forkSpawnCount = 0
    Bun.spawn = (...args: unknown[]) => {
      const options = args[0] as { cmd?: unknown } | undefined
      if (Array.isArray(options?.cmd) && options.cmd.includes('--fork-child')) forkSpawnCount++
      return originalSpawn(...args)
    }
    const provider = new ScheduledProvider(4, (turn) => {
      if (turn === 4) {
        process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({ text: 'prefix skip succeeded' })
      }
    })
    setProvider(provider)

    const { events, result } = await collectQuery(
      query('Skip until a real prefix exists', { repoRoot: process.cwd() }),
    )

    expect(result.exit_reason).toBe('completed')
    expect(result.turns).toBe(5)
    expect(forkSpawnCount).toBe(2)
    expect(events.filter((event) => event.type === 'compact').length).toBe(1)
  })

  it('resets consecutive failures after success so later compaction can run', async () => {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
    process.env.OCTONOESIS_FORK_MOCK = '{invalid-json'
    let forkSpawnCount = 0
    Bun.spawn = (...args: unknown[]) => {
      const options = args[0] as { cmd?: unknown } | undefined
      if (Array.isArray(options?.cmd) && options.cmd.includes('--fork-child')) forkSpawnCount++
      return originalSpawn(...args)
    }
    const provider = new ScheduledProvider(7, (turn) => {
      if (turn === 4) {
        process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({ text: 'first reset summary' })
      } else if (turn === 5) {
        process.env.OCTONOESIS_FORK_MOCK = '{invalid-json'
      } else if (turn === 7) {
        process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({ text: 'second reset summary' })
      }
    })
    setProvider(provider)

    const { events, result } = await collectQuery(
      query('Exercise failure counter resets', { repoRoot: process.cwd() }),
    )
    const compactEvents = events.filter((event) => event.type === 'compact')

    expect(result.exit_reason).toBe('completed')
    expect(result.turns).toBe(8)
    expect(forkSpawnCount).toBe(5)
    expect(compactEvents.length).toBe(2)
    expect(JSON.stringify(provider.calls[7])).toContain('second reset summary')
  })

  it('prints a one-line compact notice in one-shot mode', async () => {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
    const provider = new ScheduledProvider(3)
    setProvider(provider)
    const writes: string[] = []
    const originalWrite = process.stdout.write
    process.stdout.write = (chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
      return true
    }

    try {
      await runQuery('Show compaction in one-shot mode')
    } finally {
      process.stdout.write = originalWrite
    }

    expect(/Context compacted: [\d,]+ → [\d,]+ tokens/.test(writes.join(''))).toBe(true)
  })

  it('adds compaction fork usage to cumulative session totals', async () => {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
    let forkSpawnCount = 0
    Bun.spawn = (...args: unknown[]) => {
      const options = args[0] as { cmd?: unknown } | undefined
      if (!Array.isArray(options?.cmd) || !options.cmd.includes('--fork-child')) {
        return originalSpawn(...args)
      }
      forkSpawnCount++
      return {
        pid: 999_991,
        stdin: { write: () => {}, end: () => {} },
        stdout: new Blob([
          `${JSON.stringify({
            text: 'usage-bearing compact summary',
            usage: { input_tokens: 17, output_tokens: 5 },
            turns: 1,
            exitReason: 'completed',
          })}\n`,
        ]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => {},
      }
    }
    setProvider(new ScheduledProvider(3))

    const { result } = await collectQuery(
      query('Account for the compaction fork', { repoRoot: process.cwd() }),
    )

    expect(forkSpawnCount).toBe(1)
    expect(result.usage).toEqual({ input_tokens: 15_117, output_tokens: 45 })
  })
})
