import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseConfig } from '../../../src/config/schema'
import { flushJournal } from '../../../src/memory/journal'
import { setConfiguredModel, setProvider } from '../../../src/providers'
import type {
  CanonicalMessage,
  LLMProvider,
  StreamEvent as ProviderEvent,
} from '../../../src/providers/types'
import { type QueryResult, type StreamEvent, query, runQuery } from '../../../src/query/engine'
import type { QueryLoopContext } from '../../../src/query/types'
import { createSessionState } from '../../../src/state/session'
import { withRetryGenerator } from '../../../src/utils/retry'
import { restoreEnv } from '../../helpers/env'

const keys = [
  'OCTONOESIS_MEMORY_DIR',
  'OCTONOESIS_DISABLE_MEMORY',
  'OCTONOESIS_DISABLE_COMPACT',
] as const
let saved: Record<string, string | undefined>
let directory: string
beforeEach(async () => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stream-recovery-')))
  process.env.OCTONOESIS_MEMORY_DIR = directory
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
})
afterEach(async () => {
  setProvider(null)
  setConfiguredModel(undefined)
  await flushJournal()
  for (const [key, value] of Object.entries(saved)) restoreEnv(key, value)
  await fs.rm(directory, { recursive: true, force: true })
})

const reset = () => Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
const text = (text: string): ProviderEvent => ({ type: 'text_delta', text })
const end: ProviderEvent = {
  type: 'message_end',
  stopReason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 7 },
}
class Provider implements LLMProvider {
  readonly name = 'anthropic' as const
  histories: CanonicalMessage[][] = []
  started: number[] = []
  constructor(private readonly scripts: (ProviderEvent | Error)[][]) {}
  async *createMessageStream(messages: CanonicalMessage[]) {
    this.histories.push(structuredClone(messages))
    this.started.push(performance.now())
    const script = this.scripts[this.histories.length - 1]
    if (!script) throw new Error('Unexpected request')
    for (const item of script) {
      if (item instanceof Error) throw item
      yield item
    }
  }
}
function context(): QueryLoopContext {
  return {
    repoRoot: directory,
    messages: [],
    config: { ...parseConfig({}), maxTurns: 1 },
    sessionId: 'retry-session',
    sessionState: createSessionState('retry-session', 'test'),
  }
}
async function collect(ctx: QueryLoopContext, onEvent?: (event: StreamEvent) => void) {
  const events: StreamEvent[] = []
  const generator = query('Finish the work', ctx)
  let step = await generator.next()
  while (!step.done) {
    events.push(step.value)
    onEvent?.(step.value)
    step = await generator.next()
  }
  return { result: step.value as QueryResult, events }
}
async function journal() {
  await flushJournal()
  return (await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

test('replays the same turn without partial history, orphan tools, usage or duplicate turn accounting', async () => {
  const provider = new Provider([
    [
      text('stale paragraph\n\nstale tail'),
      { type: 'tool_use', id: 'stale', name: 'NeverExecute', input: {} },
      end,
      reset(),
    ],
    [text('Recovered'), end],
  ])
  setProvider(provider)
  const ctx = context()
  const { result, events } = await collect(ctx)
  expect(result.exit_reason).toBe('completed')
  expect(result.final_message).toBe('Recovered')
  expect(result.turns).toBe(1)
  expect(result.usage).toEqual({ input_tokens: 5, output_tokens: 7 })
  expect(ctx.sessionState?.turns).toBe(1)
  expect(ctx.sessionState?.usage).toEqual(result.usage)
  expect(provider.histories.length).toBe(2)
  expect(provider.histories[1]).toEqual(provider.histories[0])
  expect(JSON.stringify(ctx.messages)).not.toContain('stale')
  expect(events.filter((event) => event.type === 'stream_retry')).toEqual([
    { type: 'stream_retry', attempt: 1, reason: 'connection reset' },
  ])
  expect(events.filter((event) => event.type === 'message_end').length).toBe(1)
  expect(events.filter((event) => event.type === 'session_state').length).toBe(1)
  expect(
    (await journal()).filter((event) => event.kind === 'turn').map((event) => event.turn),
  ).toEqual([1])
})

test('two retries use exponential backoff, then exhaust to fatal_error', async () => {
  const provider = new Provider(Array.from({ length: 3 }, () => [text('stale'), reset()]))
  setProvider(provider)
  const ctx = context()
  const failures: number[] = []
  const { result, events } = await collect(ctx, (event) => {
    if (event.type === 'stream_retry') failures.push(performance.now())
  })
  expect(result.exit_reason).toBe('fatal_error')
  expect(result.error).toBe('connection reset')
  expect(provider.histories.length).toBe(3)
  expect(
    events.filter((event) => event.type === 'stream_retry').map((event) => event.attempt),
  ).toEqual([1, 2])
  expect((provider.started[1] ?? 0) - (failures[0] ?? 0)).toBeGreaterThan(490)
  expect((provider.started[2] ?? 0) - (failures[1] ?? 0)).toBeGreaterThan(990)
  expect(result.turns).toBe(1)
  expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  expect(ctx.messages?.some((message) => message.role === 'assistant')).toBe(false)
})

test('a non-retriable mid-stream error remains fatal without a retry', async () => {
  const provider = new Provider([
    [text('stale'), Object.assign(new Error('bad request'), { status: 400 })],
  ])
  setProvider(provider)
  const { result, events } = await collect(context())
  expect(result.exit_reason).toBe('fatal_error')
  expect(result.error).toBe('bad request')
  expect(provider.histories.length).toBe(1)
  expect(events.filter((event) => event.type === 'stream_retry')).toEqual([])
})

test('abort during backoff exits promptly as user_cancel without another request', async () => {
  const provider = new Provider([
    [text('stale'), reset()],
    [text('unexpected'), end],
  ])
  setProvider(provider)
  const controller = new AbortController()
  let abortedAt = 0
  const { result } = await collect({ ...context(), abortSignal: controller.signal }, (event) => {
    if (event.type === 'stream_retry')
      setTimeout(() => {
        abortedAt = performance.now()
        controller.abort()
      }, 20)
  })
  expect(result.exit_reason).toBe('user_cancel')
  expect(performance.now() - abortedAt).toBeLessThan(400)
  expect(provider.histories.length).toBe(1)
  expect((await journal()).some((event) => event.kind === 'user' && event.cancel)).toBe(true)
})

test('an already aborted failed stream is never retried', async () => {
  const controller = new AbortController()
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield text('stale')
      controller.abort()
      throw reset()
    },
  })
  const { result, events } = await collect({ ...context(), abortSignal: controller.signal })
  expect(result.exit_reason).toBe('user_cancel')
  expect(events.filter((event) => event.type === 'stream_retry')).toEqual([])
})

test('pre-first-event retries remain inside withRetryGenerator, without an extra engine retry', async () => {
  let attempts = 0
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield* withRetryGenerator(
        async function* (): AsyncGenerator<ProviderEvent> {
          attempts++
          if (attempts <= 2) throw reset()
          yield text('unexpected extra attempt')
        },
        { maxAttempts: 2, baseDelayMs: 1 },
      )
    },
  })
  const { result, events } = await collect(context())
  expect(attempts).toBe(2)
  expect(result.exit_reason).toBe('fatal_error')
  expect(events.filter((event) => event.type === 'stream_retry')).toEqual([])
})

test('a successful retry still goes through max-output-token truncation recovery', async () => {
  const provider = new Provider([
    [text('stale'), reset()],
    [text('unfinished'), { ...end, stopReason: 'max_tokens' }],
    [text('Recovered'), end],
  ])
  setProvider(provider)
  const ctx = context()
  ctx.config = { ...parseConfig({}), maxTurns: 2 }
  const { result, events } = await collect(ctx)
  expect(result.exit_reason).toBe('completed')
  expect(result.turns).toBe(2)
  expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 14 })
  expect(JSON.stringify(ctx.messages)).not.toContain('stale')
  expect(JSON.stringify(provider.histories[2])).toContain(
    'Otherwise continue exactly where you stopped.',
  )
  expect(events.filter((event) => event.type === 'stream_retry').length).toBe(1)
  expect((await journal()).filter((event) => event.kind === 'truncation').length).toBe(1)
})

test('one-shot mode writes the retry notice to stderr', async () => {
  setProvider(
    new Provider([
      [text('stale'), reset()],
      [text('Recovered'), end],
    ]),
  )
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  let errors = ''
  process.stdout.write = (() => true) as typeof stdout
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors += chunk.toString()
    return true
  }) as typeof stderr
  try {
    await runQuery('Finish the work', undefined, parseConfig({}), { stdoutIsTTY: false })
    expect(errors).toContain('↻ connection lost, retrying (1/2)\n')
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
})
