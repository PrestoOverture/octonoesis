import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { setProvider } from '../../src/providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
} from '../../src/providers/types'
import { type QueryResult, type StreamEvent, query } from '../../src/query/engine'
import type { QueryLoopContext } from '../../src/query/types'
import type { Tool } from '../../src/tools/Tool'
import { registerTool, unregisterTool } from '../../src/tools/registry'

async function collectQuery(
  generator: AsyncGenerator<StreamEvent, QueryResult, undefined>,
): Promise<QueryResult> {
  let step = await generator.next()
  while (!step.done) step = await generator.next()
  return step.value
}

function assertCompleteToolPairing(messages: CanonicalMessage[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      const paired = messages
        .slice(index + 1)
        .some((candidate) => candidate.role === 'tool' && candidate.tool_use_id === block.id)
      if (!paired) throw new Error(`Unpaired tool_use: ${block.id}`)
    }
  }
}

class PairingProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  calls = 0

  async *createMessageStream(
    messages: CanonicalMessage[],
    _tools: CanonicalTool[],
  ): AsyncIterable<ProviderStreamEvent> {
    assertCompleteToolPairing(messages)
    this.calls++
    if (this.calls === 1) {
      yield { type: 'tool_use', id: 'abort-first', name: 'AbortQuery', input: {} }
      yield { type: 'tool_use', id: 'must-not-run', name: 'MustNotRun', input: {} }
      yield { type: 'message_end', usage: { input_tokens: 3, output_tokens: 2 } }
      return
    }
    yield { type: 'text_delta', text: 'Continued successfully.' }
    yield { type: 'message_end', usage: { input_tokens: 2, output_tokens: 1 } }
  }
}

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY
const originalDisableCompact = process.env.OCTONOESIS_DISABLE_COMPACT
let memoryDir = ''

beforeEach(async () => {
  memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-cancel-pairing-'))
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
})

afterEach(async () => {
  setProvider(null)
  await fs.rm(memoryDir, { recursive: true, force: true })
  for (const [key, value] of [
    ['OCTONOESIS_MEMORY_DIR', originalMemoryDir],
    ['OCTONOESIS_DISABLE_MEMORY', originalDisableMemory],
    ['OCTONOESIS_DISABLE_COMPACT', originalDisableCompact],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

test('repairs streamed tool pairing before a cancelled session continues', async () => {
  const controller = new AbortController()
  let mustNotRunCalls = 0
  const abortTool: Tool<Record<string, never>, string> = {
    name: 'AbortQuery',
    description: 'Abort the active query',
    inputSchema: z.object({}).strict(),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    call: async () => {
      controller.abort()
      return { ok: true, value: 'aborted' }
    },
  }
  const mustNotRunTool: Tool<Record<string, never>, string> = {
    name: 'MustNotRun',
    description: 'Records an unexpected invocation',
    inputSchema: z.object({}).strict(),
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    call: async () => {
      mustNotRunCalls++
      return { ok: true, value: 'unexpected' }
    },
  }
  registerTool(abortTool)
  registerTool(mustNotRunTool)

  try {
    const provider = new PairingProvider()
    setProvider(provider)
    const ctx: QueryLoopContext = {
      repoRoot: process.cwd(),
      sessionId: 'cancel-pairing-session',
      messages: [],
      tasks: new Map(),
    }

    const cancelled = await collectQuery(query('Start both tools', ctx, controller.signal))
    const continued = await collectQuery(
      query('Continue after cancellation', ctx, new AbortController().signal),
    )

    expect(cancelled.exit_reason).toBe('user_cancel')
    expect(continued.exit_reason).toBe('completed')
    expect(continued.final_message).toBe('Continued successfully.')
    expect(mustNotRunCalls).toBe(0)

    const cancelledResult = ctx.messages?.find(
      (message) => message.role === 'tool' && message.tool_use_id === 'must-not-run',
    )
    expect(cancelledResult).toBeDefined()
    expect(
      Array.isArray(cancelledResult?.content) &&
        cancelledResult.content.some(
          (block) =>
            block.type === 'tool_result' &&
            block.tool_use_id === 'must-not-run' &&
            block.content === 'Tool execution cancelled by user.' &&
            block.is_error === true,
        ),
    ).toBe(true)

    const journalRows = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(
      journalRows.some(
        (row) =>
          row.kind === 'user' && row.cancel === true && row.session_id === 'cancel-pairing-session',
      ),
    ).toBe(true)
  } finally {
    unregisterTool(abortTool.name, abortTool)
    unregisterTool(mustNotRunTool.name, mustNotRunTool)
  }
})
