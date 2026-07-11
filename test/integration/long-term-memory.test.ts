// biome-ignore lint/suspicious/noExplicitAny: Bun.main is writable in the test runtime.
declare const Bun: any

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyMemoryWrites, loadMemories } from '../../src/memory/auto/store'
import type { MemoryWrite } from '../../src/memory/auto/types'
import { flushJournal } from '../../src/memory/journal'
import { setProvider } from '../../src/providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
} from '../../src/providers/types'
import { type QueryResult, type StreamEvent, query } from '../../src/query'

const cliPath = path.resolve('src/cli.tsx')
const originalEnv = {
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  forkMock: process.env.OCTONOESIS_FORK_MOCK,
  forkDepth: process.env.OCTONOESIS_FORK_DEPTH,
  disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
  disableCompact: process.env.OCTONOESIS_DISABLE_COMPACT,
}

interface ProviderCall {
  system?: string
  dynamicSystem?: string
}

class ToolThenFinalProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  readonly calls: ProviderCall[] = []
  private turn = 0

  async *createMessageStream(
    _messages: CanonicalMessage[],
    _tools: CanonicalTool[],
    opts: { system?: string; dynamicSystem?: string },
  ): AsyncIterable<ProviderStreamEvent> {
    this.calls.push({ system: opts.system, dynamicSystem: opts.dynamicSystem })
    this.turn++
    if (this.turn === 1) {
      yield { type: 'tool_use', id: 'read-project', name: 'Read', input: { path: 'package.json' } }
      yield { type: 'message_end', usage: { input_tokens: 4, output_tokens: 2 } }
      return
    }

    yield { type: 'text_delta', text: 'SESSION_RESULT_UNCHANGED' }
    yield { type: 'message_end', usage: { input_tokens: 3, output_tokens: 1 } }
  }
}

async function collectQuery(
  generator: AsyncGenerator<StreamEvent, QueryResult, undefined>,
): Promise<QueryResult> {
  let step = await generator.next()
  while (!step.done) step = await generator.next()
  return step.value
}

function write(overrides: Partial<MemoryWrite> = {}): MemoryWrite {
  return {
    action: 'create',
    name: 'durable-preference',
    type: 'user',
    description: 'A durable test preference',
    content: 'RECALLED_BODY_CANARY: prefer behavior-focused tests.',
    ...overrides,
  }
}

describe('long-term memory integration', () => {
  let originalMain: string
  let tempDir = ''
  let repoRoot = ''
  let memoryDir = ''

  beforeEach(async () => {
    originalMain = Bun.main
    Bun.main = cliPath
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-long-memory-'))
    repoRoot = path.join(tempDir, 'repo')
    memoryDir = path.join(tempDir, 'state')
    await fs.mkdir(repoRoot, { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'package.json'), '{"name":"fixture"}', 'utf8')
    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    process.env.OCTONOESIS_DISABLE_COMPACT = '1'
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
    Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
  })

  afterEach(async () => {
    setProvider(null)
    await flushJournal()
    Bun.main = originalMain
    await fs.rm(tempDir, { recursive: true, force: true })
    for (const [key, value] of Object.entries({
      OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
      OCTONOESIS_FORK_MOCK: originalEnv.forkMock,
      OCTONOESIS_FORK_DEPTH: originalEnv.forkDepth,
      OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
      OCTONOESIS_DISABLE_COMPACT: originalEnv.disableCompact,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })

  it('writes a memory, index line, and v2 journal event after a completed session', async () => {
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({ text: JSON.stringify([write()]) })
    setProvider(new ToolThenFinalProvider())

    const result = await collectQuery(
      query('Remember that I prefer behavior-focused tests.', {
        repoRoot,
        sessionId: 'memory-extraction-session',
      }),
    )

    expect(result.exit_reason).toBe('completed')
    const memoryPath = path.join(memoryDir, 'memory', 'durable-preference.md')
    expect(await fs.readFile(memoryPath, 'utf8')).toContain('RECALLED_BODY_CANARY')
    expect(await fs.readFile(path.join(memoryDir, 'memory', 'MEMORY.md'), 'utf8')).toContain(
      '- [durable-preference](durable-preference.md) — A durable test preference',
    )
    const rows = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(
      rows.some(
        (row) =>
          row.kind === 'memory_write' &&
          row.name === 'durable-preference' &&
          row.action === 'create' &&
          row.schema_version === 2,
      ),
    ).toBe(true)
  })

  it('loads CLAUDE.md and MEMORY.md into stable system and recalled body into preamble', async () => {
    await applyMemoryWrites([write()])
    await flushJournal()
    await fs.writeFile(path.join(repoRoot, 'CLAUDE.md'), 'CLAUDE_INSTRUCTION_CANARY', 'utf8')
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({
      text: JSON.stringify(['durable-preference']),
    })
    const provider = new ToolThenFinalProvider()
    setProvider(provider)
    const ctx = { repoRoot, sessionId: 'memory-recall-session' }

    const result = await collectQuery(query('How should tests be written?', ctx))

    expect(result).toEqual({
      exit_reason: 'completed',
      usage: { input_tokens: 7, output_tokens: 3 },
      turns: 2,
      final_message: 'SESSION_RESULT_UNCHANGED',
    })
    expect(provider.calls[0]?.system).toContain('CLAUDE_INSTRUCTION_CANARY')
    expect(provider.calls[0]?.system).toContain(
      '- [durable-preference](durable-preference.md) — A durable test preference',
    )
    expect(provider.calls[0]?.dynamicSystem).toContain('RECALLED_BODY_CANARY')
    expect(provider.calls[1]?.system).toBe(provider.calls[0]?.system)
    expect(provider.calls[1]?.dynamicSystem).toBe(provider.calls[0]?.dynamicSystem)
    expect((ctx as { firstTurnDynamicSystem?: string }).firstTurnDynamicSystem).toBe(
      provider.calls[0]?.dynamicSystem,
    )
    expect((await loadMemories()).map((memory) => memory.name)).toEqual(['durable-preference'])

    await flushJournal()
    const rows = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.filter((row) => row.kind === 'memory_write').length).toBe(1)
  })
})
