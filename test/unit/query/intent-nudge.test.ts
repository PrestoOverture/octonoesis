import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { parseConfig } from '../../../src/config/schema'
import { isKnownJournalEvent, parseJournalEvent } from '../../../src/memory/events'
import { flushJournal } from '../../../src/memory/journal'
import { setConfiguredModel, setProvider } from '../../../src/providers'
import type { CanonicalMessage, LLMProvider, StreamEvent } from '../../../src/providers/types'
import { type QueryResult, query } from '../../../src/query/engine'
import type { QueryLoopContext } from '../../../src/query/types'
import { registerTool, unregisterTool } from '../../../src/tools/registry'
import { restoreEnv } from '../../helpers/env'

const note =
  'You described what you will do but made no tool call, so nothing happened. If you intend to act, call the tools now. If you are done or need the user, say so explicitly.'
const envKeys = [
  'OCTONOESIS_MEMORY_DIR',
  'OCTONOESIS_DISABLE_MEMORY',
  'OCTONOESIS_DISABLE_COMPACT',
  'OCTONOESIS_FORK_DEPTH',
] as const
let savedEnv: Record<string, string | undefined>
let directory: string
let executions: number

beforeEach(async () => {
  savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'intent-nudge-')))
  process.env.OCTONOESIS_MEMORY_DIR = directory
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
  Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
  executions = 0
  registerTool({
    name: 'IntentProbe',
    description: 'Records that the intended action happened.',
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    async call() {
      executions++
      return { ok: true, value: 'Action completed.' }
    },
  })
})

afterEach(async () => {
  setProvider(null)
  setConfiguredModel(undefined)
  unregisterTool('IntentProbe')
  await flushJournal()
  for (const [key, value] of Object.entries(savedEnv)) restoreEnv(key, value)
  await fs.rm(directory, { recursive: true, force: true })
})

const end: StreamEvent = {
  type: 'message_end',
  stopReason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 10 },
}
const textTurn = (text: string): StreamEvent[] => [{ type: 'text_delta', text }, end]
const toolTurn: StreamEvent[] = [
  { type: 'text_delta', text: "I'll create the file for you." },
  { type: 'tool_use', id: 'intent-action', name: 'IntentProbe', input: {} },
  { ...end, stopReason: 'tool_use' },
]

class ScriptedProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  histories: CanonicalMessage[][] = []
  constructor(private readonly turns: StreamEvent[][]) {}

  async *createMessageStream(messages: CanonicalMessage[]): AsyncIterable<StreamEvent> {
    this.histories.push(structuredClone(messages))
    const turn = this.turns[this.histories.length - 1]
    if (!turn) throw new Error('Unexpected extra provider request')
    yield* turn
  }
}

function context(): QueryLoopContext {
  return { repoRoot: directory, sessionId: 'intent-session', messages: [], config: parseConfig({}) }
}

async function run(ctx: QueryLoopContext): Promise<QueryResult> {
  const generator = query('Create the requested file', ctx)
  let step = await generator.next()
  while (!step.done) step = await generator.next()
  return step.value
}

function notes(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.filter((message) => message.role === 'user' && message.content === note)
}

async function nudgeEvents(): Promise<Record<string, unknown>[]> {
  await flushJournal()
  return (await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((event) => event.kind === 'intent_nudge')
}

test('nudges once, preserves the assistant turn, executes the next tool and journals the nudge', async () => {
  const intent = "I'll create the file for you."
  const provider = new ScriptedProvider([textTurn(intent), toolTurn, textTurn('Created the file.')])
  setProvider(provider)
  const ctx = context()
  const result = await run(ctx)

  expect(result.exit_reason).toBe('completed')
  expect(result.turns).toBe(3)
  expect(result.final_message).toBe('Created the file.')
  expect(executions).toBe(1)
  expect(provider.histories.length).toBe(3)
  expect(provider.histories[1]?.slice(-2)).toEqual([
    { role: 'assistant', content: [{ type: 'text', text: intent }] },
    { role: 'user', content: note },
  ])
  expect(notes(ctx.messages ?? []).length).toBe(1)
  expect(provider.histories[2]?.at(-1)?.role).toBe('tool')
  expect(provider.histories[2]?.at(-1)).toEqual(ctx.messages?.at(-2))
  const events = await nudgeEvents()
  expect(events.length).toBe(1)
  expect(events[0]).toEqual({
    ts: events[0]?.ts,
    kind: 'intent_nudge',
    turn: 1,
    session_id: 'intent-session',
    schema_version: 2,
  })
  expect(typeof events[0]?.ts).toBe('string')
  const parsed = parseJournalEvent(events[0])
  expect(parsed).not.toBe(null)
  expect(parsed && isKnownJournalEvent(parsed)).toBe(true)
  expect(parseJournalEvent({ kind: 'future_event', schema_version: 99 })).toEqual({
    kind: 'future_event',
    schema_version: 99,
  })
})

test('a second intent-only turn ends normally without a second nudge', async () => {
  const second = 'Let me write the file now.'
  const provider = new ScriptedProvider([textTurn("I'll create it."), textTurn(second)])
  setProvider(provider)
  const ctx = context()
  const result = await run(ctx)
  expect(result.exit_reason).toBe('completed')
  expect(result.turns).toBe(2)
  expect(result.final_message).toBe(second)
  expect(provider.histories.length).toBe(2)
  expect(notes(ctx.messages ?? []).length).toBe(1)
  expect((await nudgeEvents()).length).toBe(1)
})

for (const intent of [
  "I'll create it.",
  'I will create it.',
  'Let me create it.',
  "I'm going to create it.",
  "Now I'll create it.",
  'First, I will read the file.',
  'First, I need to read the file.',
  'I understand. I’ll create foo.ts.',
  '我来创建文件。',
  '我将创建文件。',
  '让我创建文件。',
  '我会创建文件。',
  '明白了。接下来我创建文件。',
  `I'll ${'a'.repeat(393)}.`, // 399 characters
]) {
  test(`detects the final intent sentence: ${intent.slice(0, 50)}`, async () => {
    const provider = new ScriptedProvider([textTurn(intent), textTurn('Done.')])
    setProvider(provider)
    const ctx = context()
    expect((await run(ctx)).turns).toBe(2)
    expect(notes(ctx.messages ?? []).length).toBe(1)
    expect((await nudgeEvents()).length).toBe(1)
  })
}

for (const answer of [
  "I'll create it. Which filename should I use?",
  '我来创建文件，可以吗？  ',
  'Let me confirm: "Which file?"',
  `I'll ${'a'.repeat(394)}.`, // 400 characters
  `${'Completed details. '.repeat(30)}I'll create it.`,
  "I'll create it. The work is done.",
  '我会创建文件。已经完成。',
  'I created the file.',
  'First, I created the file.',
  '',
]) {
  test(`does not nudge a question or final answer: ${answer.slice(0, 50)}`, async () => {
    const provider = new ScriptedProvider([textTurn(answer)])
    setProvider(provider)
    const ctx = context()
    const result = await run(ctx)
    expect(result.exit_reason).toBe('completed')
    expect(result.turns).toBe(1)
    expect(result.final_message).toBe(answer)
    expect(provider.histories.length).toBe(1)
    expect(notes(ctx.messages ?? []).length).toBe(0)
    expect((await nudgeEvents()).length).toBe(0)
  })
}

test('a turn with tool calls is never nudged', async () => {
  const provider = new ScriptedProvider([toolTurn, textTurn('Done.')])
  setProvider(provider)
  const ctx = context()
  expect((await run(ctx)).turns).toBe(2)
  expect(executions).toBe(1)
  expect(notes(ctx.messages ?? []).length).toBe(0)
  expect((await nudgeEvents()).length).toBe(0)
})

test('intentNudge=false disables the nudge', async () => {
  const provider = new ScriptedProvider([textTurn("I'll create it.")])
  setProvider(provider)
  const ctx = context()
  ctx.config = parseConfig({ intentNudge: false })
  expect((await run(ctx)).turns).toBe(1)
  expect(notes(ctx.messages ?? []).length).toBe(0)
  expect((await nudgeEvents()).length).toBe(0)
})

test('the nudge allowance resets for each user query in the same session', async () => {
  const provider = new ScriptedProvider([
    textTurn("I'll create it."),
    textTurn('Done.'),
    textTurn('我来创建文件。'),
    textTurn('Done.'),
  ])
  setProvider(provider)
  const ctx = context()
  expect((await run(ctx)).turns).toBe(2)
  expect((await run(ctx)).turns).toBe(2)
  expect(notes(ctx.messages ?? []).length).toBe(2)
  expect((await nudgeEvents()).length).toBe(2)
})

test('a nudge still respects turn and token budgets', async () => {
  for (const limit of ['turn', 'token']) {
    const provider = new ScriptedProvider([textTurn("I'll create it.")])
    setProvider(provider)
    const ctx = context()
    ctx.config = parseConfig({ maxTurns: limit === 'turn' ? 1 : 50 })
    if (limit === 'token') ctx.tokenBudget = 1
    expect((await run(ctx)).exit_reason).toBe(limit === 'turn' ? 'max_turns' : 'budget_exceeded')
    expect(provider.histories.length).toBe(1)
    expect(notes(ctx.messages ?? []).length).toBe(1)
  }
})
