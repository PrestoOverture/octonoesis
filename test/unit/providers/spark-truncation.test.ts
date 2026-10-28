import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type ChatCompletionChunk,
  type ChatCompletionCreateParams,
  Completions,
} from 'openai/resources/chat/completions'
import { z } from 'zod'
import { parseConfig } from '../../../src/config/schema'
import { flushJournal } from '../../../src/memory/journal'
import { setConfiguredModel, setProvider } from '../../../src/providers'
import { OpenAIProvider } from '../../../src/providers/openai'
import type { StreamEvent } from '../../../src/providers/types'
import { query } from '../../../src/query/engine'
import { registerTool, unregisterTool } from '../../../src/tools/registry'
import {
  getProviderCredentialEnvironment,
  setProviderCredentialsForTests,
} from '../../../src/utils/env'
import { restoreEnv } from '../../helpers/env'

type Chunk = Pick<ChatCompletionChunk, 'choices' | 'usage'>
const chunk = (
  delta: ChatCompletionChunk.Choice.Delta,
  finish_reason: ChatCompletionChunk.Choice['finish_reason'] = null,
): Chunk => ({ choices: [{ index: 0, delta, finish_reason }] })
const tool = (id = 'cut', name = 'Write', args = '{"content":'): Chunk =>
  chunk({ tool_calls: [{ index: 0, id, function: { name, arguments: args } }] })
const markerError = () => new Error('Spark tool call stream ended before </tool_call>')
const usage: Chunk = {
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
}
const originalCreate = Completions.prototype.create
const credentials = getProviderCredentialEnvironment()
const envKeys = [
  'OCTONOESIS_MEMORY_DIR',
  'OCTONOESIS_DISABLE_MEMORY',
  'OCTONOESIS_DISABLE_COMPACT',
] as const
let saved: Record<string, string | undefined>
let directory: string
let requests: ChatCompletionCreateParams[]
let executed: unknown[]

beforeEach(async () => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'spark-truncation-')))
  process.env.OCTONOESIS_MEMORY_DIR = directory
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
  setProviderCredentialsForTests({ OPENAI_API_KEY: 'test-key', SPARK_API_KEY: 'test-key' })
  requests = []
  executed = []
  registerTool({
    name: 'SparkTruncationProbe',
    description: 'Record dispatched calls',
    inputSchema: z.unknown(),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async call(input) {
      executed.push(input)
      return { ok: true, value: 'done' }
    },
  })
})

afterEach(async () => {
  Completions.prototype.create = originalCreate
  setProviderCredentialsForTests(credentials)
  setProvider(null)
  setConfiguredModel(undefined)
  unregisterTool('SparkTruncationProbe')
  await flushJournal()
  for (const [key, value] of Object.entries(saved)) restoreEnv(key, value)
  await fs.rm(directory, { recursive: true, force: true })
})

function mockStreams(scripts: (Chunk | Error)[][], beforeThrow?: () => void) {
  Completions.prototype.create = ((body: ChatCompletionCreateParams) => {
    const script = scripts[requests.length]
    requests.push(structuredClone(body))
    if (!script) throw new Error('Unexpected additional provider request')
    return (async function* () {
      for (const item of script) {
        if (item instanceof Error) {
          beforeThrow?.()
          throw item
        }
        yield item
      }
    })()
  }) as unknown as typeof originalCreate
}

async function collect(mode: 'openai' | 'spark', signal = new AbortController().signal) {
  const events: StreamEvent[] = []
  for await (const event of new OpenAIProvider(mode).createMessageStream([], [], {
    model: 'test',
    maxTokens: 256,
    signal,
  }))
    events.push(event)
  return events
}

async function run() {
  setProvider(new OpenAIProvider('spark'))
  const ctx = {
    repoRoot: directory,
    sessionId: 'spark-truncation-session',
    messages: [],
    config: { ...parseConfig({}), maxOutputTokens: 256 },
  }
  const events = []
  const generator = query('Finish the file with tools', ctx)
  let step = await generator.next()
  while (!step.done) {
    events.push(step.value)
    step = await generator.next()
  }
  await flushJournal()
  const journal = (await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  return { result: step.value, events, ctx, journal }
}

for (const mode of ['openai', 'spark'] as const) {
  test(`${mode}: invalid tool arguments without any finish_reason imply max_tokens`, async () => {
    mockStreams([
      [tool(), chunk({ tool_calls: [{ index: 0, function: { arguments: '"unfinished' } }] })],
    ])
    expect(await collect(mode)).toEqual([
      {
        type: 'message_end',
        stopReason: 'max_tokens',
        invalidToolCalls: [{ id: 'cut', name: 'Write' }],
        lastToolUseId: 'cut',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ])
    expect(requests.length).toBe(1)
  })

  test(`${mode}: an explicit unrecognised finish_reason is preserved for invalid tool arguments`, async () => {
    mockStreams([[tool(), chunk({}, 'content_filter')]])
    const events = await collect(mode)
    expect(events.at(-1)).toEqual({
      type: 'message_end',
      stopReason: 'other',
      invalidToolCalls: [{ id: 'cut', name: 'Write' }],
      lastToolUseId: 'cut',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
  })
}

for (const knownUsage of [false, true]) {
  test(`Spark marker error becomes a dropped truncation, with ${knownUsage ? 'known' : 'zero'} usage`, async () => {
    mockStreams([[tool(), ...(knownUsage ? [usage] : []), markerError()]])
    expect(await collect('spark')).toEqual([
      {
        type: 'message_end',
        stopReason: 'max_tokens',
        invalidToolCalls: [{ id: 'cut', name: 'Write' }],
        lastToolUseId: 'cut',
        usage: { input_tokens: knownUsage ? 12 : 0, output_tokens: knownUsage ? 34 : 0 },
      },
    ])
    expect(requests.length).toBe(1)
  })
}

test('Spark marker errors discard every buffered call, including parseable but unfinished calls', async () => {
  mockStreams([
    [
      chunk({
        tool_calls: [
          { index: 1, id: 'last', function: { name: 'Write', arguments: '{"content":' } },
          { index: 0, id: 'first', function: { name: 'Read', arguments: '{"path":"file"}' } },
        ],
      }),
      markerError(),
    ],
  ])
  expect(await collect('spark')).toEqual([
    {
      type: 'message_end',
      stopReason: 'max_tokens',
      invalidToolCalls: [
        { id: 'first', name: 'Read' },
        { id: 'last', name: 'Write' },
      ],
      lastToolUseId: 'last',
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  ])
})

test('Spark marker errors with no known call produce a synthetic unknown call', async () => {
  mockStreams([[chunk({ content: 'Preparing a file' }), markerError()]])
  const events = await collect('spark')
  const end = events.at(-1)
  expect(end?.type).toBe('message_end')
  if (end?.type !== 'message_end') throw new Error('Missing message_end')
  expect(end.stopReason).toBe('max_tokens')
  expect(end.invalidToolCalls?.length).toBe(1)
  expect(end.invalidToolCalls?.[0]?.name).toBe('unknown')
  expect(Boolean(end.lastToolUseId)).toBe(true)
  expect(end.lastToolUseId).toBe(end.invalidToolCalls?.[0]?.id)
  expect(requests.length).toBe(1)
})

test('OpenAI still throws the Spark marker error after tool-call deltas', async () => {
  const error = markerError()
  mockStreams([[tool(), error]])
  let caught: unknown
  try {
    await collect('openai')
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(error)
  expect(requests.length).toBe(1)
})

test('Spark still throws the marker error before any chunks arrive', async () => {
  const error = markerError()
  mockStreams([[error]])
  let caught: unknown
  try {
    await collect('spark')
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(error)
  expect(requests.length).toBe(1)
})

test('Spark preserves aborts even when the error matches the truncation marker', async () => {
  const controller = new AbortController()
  const error = markerError()
  mockStreams([[tool(), error]], () => controller.abort())
  let caught: unknown
  try {
    await collect('spark', controller.signal)
  } catch (error) {
    caught = error
  }
  expect(caught).toBe(error)
})

test('the engine recovers from a Spark marker error with a chunking note and continues through tools', async () => {
  mockStreams([
    [tool('cut', 'SparkTruncationProbe'), markerError()],
    [tool('recovered', 'SparkTruncationProbe', '{"id":"recovered"}'), chunk({}, 'tool_calls')],
    [chunk({ content: 'Finished.' }, 'stop')],
  ])
  const { result, events, ctx, journal } = await run()
  expect(result.exit_reason).toBe('completed')
  expect(result.final_message).toBe('Finished.')
  expect(result.turns).toBe(3)
  expect(requests.length).toBe(3)
  expect(executed).toEqual([{ id: 'recovered' }])
  const note = requests[1]?.messages.at(-1)?.content
  expect(note).toContain('cut at 256 tokens')
  expect(note).toContain('SparkTruncationProbe (cut) was dropped and NOT executed')
  expect(note).toContain('Write a skeleton, then Edit in chunks')
  expect(events.filter((event) => event.type === 'stream_retry')).toEqual([])
  expect(JSON.stringify(ctx.messages)).not.toContain('"id":"cut"')
  const truncations = journal.filter((event) => event.kind === 'truncation')
  expect(truncations.length).toBe(1)
  expect(truncations[0].dropped_tool_calls).toEqual([
    { id: 'cut', name: 'SparkTruncationProbe', reason: 'invalid_arguments' },
  ])
})

for (const ending of ['silent', 'marker'] as const) {
  test(`${ending} Spark truncations are journalled and counted by the three-turn breaker`, async () => {
    mockStreams(
      Array.from({ length: 3 }, () => [tool(), ...(ending === 'marker' ? [markerError()] : [])]),
    )
    const { result, events, journal } = await run()
    expect(result.exit_reason).toBe('fatal_error')
    expect(result.error).toContain('3 consecutive truncation recoveries')
    expect(result.turns).toBe(3)
    expect(requests.length).toBe(3)
    expect(
      journal.filter((event) => event.kind === 'truncation').map((event) => event.turn),
    ).toEqual([1, 2, 3])
    expect(events.filter((event) => event.type === 'stream_retry')).toEqual([])
    expect(executed).toEqual([])
  })
}
