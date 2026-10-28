import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { parseConfig } from '../../../src/config/schema'
import { isKnownJournalEvent, parseJournalEvent } from '../../../src/memory/events'
import { flushJournal } from '../../../src/memory/journal'
import { setConfiguredModel, setProvider } from '../../../src/providers'
import { OpenAIProvider } from '../../../src/providers/openai'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent as ProviderEvent,
} from '../../../src/providers/types'
import { compact, createCompactSummaryMessage } from '../../../src/query/compact'
import { type QueryResult, type StreamEvent, query } from '../../../src/query/engine'
import type { QueryLoopContext } from '../../../src/query/types'
import { registerTool, unregisterTool } from '../../../src/tools/registry'
import {
  getProviderCredentialEnvironment,
  setProviderCredentialsForTests,
} from '../../../src/utils/env'
import { restoreEnv } from '../../helpers/env'

const envKeys = [
  'OCTONOESIS_MEMORY_DIR',
  'OCTONOESIS_DISABLE_MEMORY',
  'OCTONOESIS_DISABLE_COMPACT',
  'OCTONOESIS_FORK_DEPTH',
] as const
let savedEnv: Record<string, string | undefined>
let directory: string
let executed: unknown[]
const credentials = getProviderCredentialEnvironment()
let originalFetch: typeof fetch

beforeEach(async () => {
  originalFetch = globalThis.fetch
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'turn-recovery-')))
  process.env.OCTONOESIS_MEMORY_DIR = directory
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
  Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
  executed = []
  registerTool({
    name: 'RecoveryProbe',
    description: 'Records every invocation, including raw strings, to detect unsafe dispatch.',
    inputSchema: z.unknown(),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async call(input) {
      executed.push(input)
      return { ok: true, value: 'observed' }
    },
  })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  setProviderCredentialsForTests(credentials)
  setProvider(null)
  setConfiguredModel(undefined)
  unregisterTool('RecoveryProbe')
  await flushJournal()
  for (const [key, value] of Object.entries(savedEnv)) restoreEnv(key, value)
  await fs.rm(directory, { recursive: true, force: true })
})

const end = (stopReason: 'end_turn' | 'tool_use' | 'max_tokens'): ProviderEvent => ({
  type: 'message_end',
  stopReason,
  usage: { input_tokens: 5, output_tokens: 256 },
})
const call = (id: string): ProviderEvent => ({
  type: 'tool_use',
  id,
  name: 'RecoveryProbe',
  input: { id },
})
const done: ProviderEvent[] = [{ type: 'text_delta', text: 'Finished.' }, end('end_turn')]

class ScriptedProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  histories: CanonicalMessage[][] = []
  limits: number[] = []
  constructor(private readonly turns: ProviderEvent[][]) {}

  async *createMessageStream(
    messages: CanonicalMessage[],
    _tools: CanonicalTool[],
    opts: Parameters<LLMProvider['createMessageStream']>[2],
  ): AsyncIterable<ProviderEvent> {
    this.histories.push(structuredClone(messages))
    this.limits.push(opts.maxTokens)
    const turn = this.turns[this.histories.length - 1]
    if (!turn) throw new Error('Unexpected extra provider request')
    yield* turn
  }
}

function context(maxOutputTokens = 256): QueryLoopContext {
  return {
    repoRoot: directory,
    sessionId: 'recovery-session',
    messages: [],
    config: { ...parseConfig({}), maxOutputTokens },
  }
}

async function run(ctx: QueryLoopContext): Promise<{ result: QueryResult; events: StreamEvent[] }> {
  const generator = query('Finish the requested work', ctx)
  const events: StreamEvent[] = []
  let step = await generator.next()
  while (!step.done) {
    events.push(step.value)
    step = await generator.next()
  }
  return { result: step.value, events }
}

async function journal(): Promise<Record<string, unknown>[]> {
  await flushJournal()
  return (await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function assertPaired(messages: CanonicalMessage[]): void {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      expect(pending.delete(message.tool_use_id)).toBe(true)
    } else {
      expect(pending.size).toBe(0)
      if (message.role === 'assistant') {
        for (const block of message.content) if (block.type === 'tool_use') pending.add(block.id)
      }
    }
  }
  expect(pending.size).toBe(0)
}

test('main turns use the default and configured maxOutputTokens', async () => {
  for (const limit of [16384, 777]) {
    const provider = new ScriptedProvider([done])
    setProvider(provider)
    const ctx = context(limit)
    if (limit === 16384) ctx.config = parseConfig({})
    expect((await run(ctx)).result.exit_reason).toBe('completed')
    expect(provider.limits).toEqual([limit])
  }
})

test('drops the final tool use on max_tokens, executes earlier calls and pairs history before the note', async () => {
  const provider = new ScriptedProvider([
    [call('safe'), call('cut'), { type: 'text_delta', text: 'partial ending' }, end('max_tokens')],
    done,
  ])
  setProvider(provider)
  const ctx = context()
  const { result, events } = await run(ctx)
  expect(result.exit_reason).toBe('completed')
  expect(result.turns).toBe(2)
  expect(executed).toEqual([{ id: 'safe' }])
  expect(events.filter((event) => event.type === 'tool_use').map((event) => event.id)).toEqual([
    'safe',
    'cut',
  ])
  expect(events.find((event) => event.type === 'tool_done' && event.id === 'cut')).toEqual({
    type: 'tool_done',
    id: 'cut',
    name: 'RecoveryProbe',
    status: 'error',
    summary: 'output truncated; not executed',
  })
  expect(
    events.filter((event) => event.type === 'message_end').map((event) => event.stopReason),
  ).toEqual(['max_tokens', 'end_turn'])
  const history = provider.histories[1] ?? []
  const assistantCalls = history.flatMap((message) =>
    message.role === 'assistant'
      ? message.content.filter((block) => block.type === 'tool_use')
      : [],
  )
  expect(assistantCalls.map((block) => block.id)).toEqual(['safe'])
  const note = history.at(-1)
  expect(note?.role).toBe('user')
  expect(note?.content).toContain('cut at 256 tokens')
  expect(note?.content).toContain('RecoveryProbe (cut) was dropped and NOT executed')
  expect(note?.content).toContain('Write a skeleton, then Edit in chunks')
  assertPaired(ctx.messages ?? [])
  const rows = await journal()
  const truncations = rows.filter((row) => row.kind === 'truncation')
  expect(truncations.length).toBe(1)
  expect(truncations[0]).toEqual({
    kind: 'truncation',
    ts: truncations[0]?.ts,
    schema_version: 2,
    session_id: 'recovery-session',
    turn: 1,
    max_output_tokens: 256,
    output_tokens: 256,
    dropped_tool_calls: [{ id: 'cut', name: 'RecoveryProbe', reason: 'max_tokens' }],
  })
  const parsed = parseJournalEvent(truncations[0])
  expect(parsed && isKnownJournalEvent(parsed)).toBe(true)
  expect(parsed).toEqual(truncations[0])
  expect(parseJournalEvent({ kind: 'future_truncation', schema_version: 9 })).toEqual({
    kind: 'future_truncation',
    schema_version: 9,
  })
})

test('a tool-only truncation leaves no empty assistant message or orphan result', async () => {
  setProvider(new ScriptedProvider([[call('cut'), end('max_tokens')], done]))
  const ctx = context()
  expect((await run(ctx)).result.exit_reason).toBe('completed')
  expect(executed).toEqual([])
  expect(ctx.messages?.filter((message) => message.role === 'tool')).toEqual([])
  expect(
    ctx.messages?.some((message) => message.role === 'assistant' && !message.content.length),
  ).toBe(false)
  assertPaired(ctx.messages ?? [])
})

test('text-only truncation appends a continue note and resumes on the next turn', async () => {
  const provider = new ScriptedProvider([
    [{ type: 'text_delta', text: 'The unfinished sentence' }, end('max_tokens')],
    done,
  ])
  setProvider(provider)
  const ctx = context()
  const { result } = await run(ctx)
  expect(result.exit_reason).toBe('completed')
  expect(result.turns).toBe(2)
  expect(result.final_message).toBe('Finished.')
  const note = provider.histories[1]?.at(-1)
  expect(note?.role).toBe('user')
  expect(note?.content).toBe(
    'Your output was cut at 256 tokens. Continue exactly where you stopped.',
  )
  expect(
    (await journal()).filter((row) => row.kind === 'truncation')[0]?.dropped_tool_calls,
  ).toEqual([])

  // The note is ordinary user history: exact task-state retention carries it even when
  // a later user request is rescued and the summarizer omits all recovery details.
  const history: CanonicalMessage[] = [
    ...(ctx.messages ?? []),
    { role: 'assistant', content: [{ type: 'text', text: 'large context '.repeat(3000) }] },
    { role: 'user', content: 'A newer ordinary request' },
    { role: 'assistant', content: [{ type: 'text', text: 'recent one' }] },
    { role: 'user', content: 'recent two' },
    { role: 'assistant', content: [{ type: 'text', text: 'recent three' }] },
  ]
  const compacted = await compact(history, {
    systemPrompt: '',
    preserveTaskState: true,
    recordEvent: false,
    forkFn: async () => ({
      text: 'Brief summary without recovery details.',
      usage: { input_tokens: 1, output_tokens: 1 },
      turns: 1,
      exitReason: 'completed',
    }),
  })
  expect(compacted.summary).toContain(String(note?.content))
  assertPaired([
    compacted.pinnedHead,
    createCompactSummaryMessage(compacted.summary),
    ...compacted.messagesKept,
  ])
})

test('three consecutive truncations exit fatal_error and journal all three attempts', async () => {
  const provider = new ScriptedProvider([
    [call('cut-1'), end('max_tokens')],
    [{ type: 'text_delta', text: 'partial' }, end('max_tokens')],
    [call('cut-3'), end('max_tokens')],
    done,
  ])
  setProvider(provider)
  const ctx = context()
  const { result } = await run(ctx)
  expect(result.exit_reason).toBe('fatal_error')
  expect(result.error).toContain('3 consecutive truncation recoveries')
  expect(result.turns).toBe(3)
  expect(provider.histories.length).toBe(3)
  expect(executed).toEqual([])
  expect(result.usage).toEqual({ input_tokens: 15, output_tokens: 768 })
  const rows = await journal()
  expect(rows.filter((row) => row.kind === 'truncation').map((row) => row.turn)).toEqual([1, 2, 3])
  expect(rows.find((row) => row.kind === 'session')?.exit_reason).toBe('fatal_error')
  assertPaired(ctx.messages ?? [])
})

test('a non-truncated tool turn resets the consecutive recovery counter', async () => {
  const cut = [{ type: 'text_delta' as const, text: 'partial' }, end('max_tokens')]
  const provider = new ScriptedProvider([cut, cut, [call('safe'), end('tool_use')], cut, cut, done])
  setProvider(provider)
  const { result } = await run(context())
  expect(result.exit_reason).toBe('completed')
  expect(result.turns).toBe(6)
  expect(executed).toEqual([{ id: 'safe' }])
})

for (const mode of ['openai', 'spark'] as const) {
  for (const finishReason of ['tool_calls', 'length']) {
    test(`${mode}: invalid JSON calls are never executed or stored (${finishReason})`, async () => {
      setProviderCredentialsForTests({ OPENAI_API_KEY: 'test-key', SPARK_API_KEY: 'test-key' })
      let requests = 0
      globalThis.fetch = async () => {
        const chunks =
          requests++ === 0
            ? [
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'bad-first',
                            function: { name: 'RecoveryProbe', arguments: '{' },
                          },
                          {
                            index: 1,
                            id: 'safe',
                            function: { name: 'RecoveryProbe', arguments: '{"id":"safe"}' },
                          },
                          {
                            index: 2,
                            id: 'bad-last',
                            function: { name: 'RecoveryProbe', arguments: '{"content":' },
                          },
                        ],
                      },
                    },
                  ],
                },
                { choices: [{ delta: {}, finish_reason: finishReason }] },
              ]
            : [{ choices: [{ delta: { content: 'Finished.' }, finish_reason: 'stop' }] }]
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
      setProvider(new OpenAIProvider(mode))
      const ctx = context()
      const { result } = await run(ctx)
      expect(result.exit_reason).toBe('completed')
      expect(requests).toBe(2)
      expect(executed).toEqual([{ id: 'safe' }])
      const assistantCalls = ctx.messages?.flatMap((message) =>
        message.role === 'assistant'
          ? message.content.filter((block) => block.type === 'tool_use')
          : [],
      )
      expect(assistantCalls?.map((block) => block.id)).toEqual(['safe'])
      const notes = ctx.messages
        ?.filter((message) => message.role === 'user')
        .map((message) => message.content)
      expect(notes?.at(-1)).toContain('bad-first')
      expect(notes?.at(-1)).toContain('bad-last')
      expect(notes?.at(-1)).toContain('NOT executed because its arguments failed JSON.parse')
      assertPaired(ctx.messages ?? [])
    })
  }
}
