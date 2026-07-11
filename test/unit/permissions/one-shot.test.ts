import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { flushJournal } from '../../../src/memory/journal'
import {
  clearAllowlist,
  setPermissionInputStreamForTests,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm'
import { setProvider } from '../../../src/providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
} from '../../../src/providers/types'
import { type QueryResult, type StreamEvent, query } from '../../../src/query/engine'

class ScriptedProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  private turn = 0

  constructor(private readonly turns: ProviderStreamEvent[][]) {}

  async *createMessageStream(
    _messages: CanonicalMessage[],
    _tools: CanonicalTool[],
  ): AsyncIterable<ProviderStreamEvent> {
    const events = this.turns[this.turn]
    this.turn++
    if (!events) throw new Error('Scripted provider exhausted')
    yield* events
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
let memoryDir = ''
let input: PassThrough | undefined

beforeEach(async () => {
  memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-one-shot-permission-'))
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
  clearAllowlist()
  unregisterPromptHandler()
  setPermissionInputStreamForTests()
})

afterEach(async () => {
  setProvider(null)
  clearAllowlist()
  unregisterPromptHandler()
  setPermissionInputStreamForTests()
  input?.destroy()
  input = undefined
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
})

describe('one-shot fallback permissions', () => {
  it('reuses piped answers across two prompts and journals the completed session', async () => {
    input = new PassThrough()
    input.write('y\ny\n')
    setPermissionInputStreamForTests(input)
    setProvider(
      new ScriptedProvider([
        [
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'printf first' } },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        [
          { type: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'printf second' } },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        [
          { type: 'text_delta', text: 'Both commands completed.' },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      ]),
    )

    const { events, result } = await collectQuery(
      query('Run two approved commands', {
        repoRoot: process.cwd(),
        sessionId: 'two-prompt-session',
      }),
    )

    expect(result.exit_reason).toBe('completed')
    expect(result.final_message).toBe('Both commands completed.')
    expect(
      events
        .filter((event) => event.type === 'tool_done')
        .map((event) => (event.type === 'tool_done' ? [event.id, event.status] : [])),
    ).toEqual([
      ['bash-1', 'done'],
      ['bash-2', 'done'],
    ])
    expect(input.isPaused()).toBe(true)

    const rows = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.session_id === 'two-prompt-session')
    const permissionRows = rows.filter((row) => row.kind === 'permission')
    expect(permissionRows.map((row) => row.decision)).toEqual(['allow_once', 'allow_once'])
    expect(
      permissionRows.every(
        (row) => row.schema_version === 1 && typeof row.key === 'string' && row.key.length > 0,
      ),
    ).toBe(true)
    expect(rows.filter((row) => row.kind === 'tool').map((row) => [row.tool, row.outcome])).toEqual(
      [
        ['Bash', 'success'],
        ['Bash', 'success'],
      ],
    )
    expect(rows.filter((row) => row.kind === 'session').map((row) => row.exit_reason)).toEqual([
      'completed',
    ])
  })

  it('denies safely after EOF and lets the query finish with an error tool result', async () => {
    input = new PassThrough()
    input.end('y\n')
    setPermissionInputStreamForTests(input)
    setProvider(
      new ScriptedProvider([
        [
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'printf first' } },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        [
          { type: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'printf second' } },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        [
          { type: 'text_delta', text: 'Handled the denied command.' },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      ]),
    )
    const messages: CanonicalMessage[] = []

    const { events, result } = await collectQuery(
      query('Run one approved and one denied command', {
        repoRoot: process.cwd(),
        sessionId: 'eof-session',
        messages,
      }),
    )

    expect(result.exit_reason).toBe('completed')
    expect(result.final_message).toBe('Handled the denied command.')
    expect(
      events
        .filter((event) => event.type === 'tool_done')
        .map((event) => (event.type === 'tool_done' ? [event.id, event.status] : [])),
    ).toEqual([
      ['bash-1', 'done'],
      ['bash-2', 'error'],
    ])
    const deniedResult = messages.find(
      (message) => message.role === 'tool' && message.tool_use_id === 'bash-2',
    )
    expect(deniedResult?.role).toBe('tool')
    expect(JSON.stringify(deniedResult)).toContain('permission_denied')

    const rows = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row.session_id === 'eof-session')
    expect(rows.filter((row) => row.kind === 'permission').map((row) => row.decision)).toEqual([
      'allow_once',
      'deny',
    ])
    expect(rows.filter((row) => row.kind === 'tool').map((row) => [row.tool, row.outcome])).toEqual(
      [
        ['Bash', 'success'],
        ['Bash', 'failure'],
      ],
    )
    expect(rows.filter((row) => row.kind === 'session').map((row) => row.exit_reason)).toEqual([
      'completed',
    ])
  })
})
