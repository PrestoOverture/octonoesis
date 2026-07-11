import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { extractMemories } from '../../../../src/memory/auto/extract'
import { applyMemoryWrites, loadMemories, loadMemoryIndex } from '../../../../src/memory/auto/store'
import type { MemoryWrite } from '../../../../src/memory/auto/types'
import { flushJournal } from '../../../../src/memory/journal'
import type { ForkOptions, ForkResult } from '../../../../src/providers/fork'
import type { CanonicalMessage } from '../../../../src/providers/types'

const originalEnv = {
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
  forkDepth: process.env.OCTONOESIS_FORK_DEPTH,
}
let tempDir = ''

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-auto-memory-extract-'))
  process.env.OCTONOESIS_MEMORY_DIR = tempDir
  Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
  Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
})

afterEach(async () => {
  await flushJournal()
  await fs.rm(tempDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries({
    OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
    OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
    OCTONOESIS_FORK_DEPTH: originalEnv.forkDepth,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

function conversation(length = 4): CanonicalMessage[] {
  return [
    { role: 'user', content: 'Remember my preference.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
    { role: 'user', content: 'Apply it to this task.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ].slice(0, length) as CanonicalMessage[]
}

function write(overrides: Partial<MemoryWrite> = {}): MemoryWrite {
  return {
    action: 'create',
    name: 'new-memory',
    type: 'user',
    description: 'A durable preference',
    content: 'Use behavior-focused tests.',
    ...overrides,
  }
}

function result(text: string): ForkResult {
  return {
    text,
    usage: { input_tokens: 1, output_tokens: 1 },
    turns: 1,
    exitReason: 'completed',
  }
}

describe('auto-memory extraction', () => {
  it('validates and applies create, update, and delete actions from an injected fork', async () => {
    await applyMemoryWrites([
      write({ name: 'update-me', description: 'Old update description' }),
      write({ name: 'delete-me', description: 'Delete description' }),
    ])
    let received: ForkOptions | undefined
    const writes = [
      write({ action: 'create', name: 'created' }),
      write({
        action: 'update',
        name: 'update-me',
        type: 'feedback',
        description: 'Updated description',
        content: 'Updated content.',
      }),
      write({ action: 'delete', name: 'delete-me', type: 'project' }),
    ]

    await extractMemories(
      { system: 'byte-stable-parent-system', messages: conversation() },
      { repoRoot: tempDir },
      {
        forkFn: async (opts) => {
          received = opts
          return result(JSON.stringify(writes))
        },
      },
    )

    const memories = await loadMemories()
    expect(
      memories.map(({ name, type, description, content }) => ({
        name,
        type,
        description,
        content,
      })),
    ).toEqual([
      {
        name: 'created',
        type: 'user',
        description: 'A durable preference',
        content: 'Use behavior-focused tests.',
      },
      {
        name: 'update-me',
        type: 'feedback',
        description: 'Updated description',
        content: 'Updated content.',
      },
    ])
    expect(received?.forkPurpose).toBe('memory_extract')
    expect(received?.systemPrompt).toBe('byte-stable-parent-system')
    expect(received?.tools).toEqual([])
    expect(received?.maxTurns).toBe(1)
    expect(received?.timeoutMs).toBe(30_000)
    expect(received && 'model' in received).toBe(false)
    expect(received?.messages.slice(0, -1)).toEqual(conversation())
    const extractionInstruction = JSON.stringify(received?.messages.at(-1))
    expect(extractionInstruction).toContain('update-me.md')
    expect(/only.*user.*own statements/i.test(extractionInstruction)).toBe(true)
    expect(/verified task outcomes/i.test(extractionInstruction)).toBe(true)
    expect(/never.*system instructions/i.test(extractionInstruction)).toBe(true)
    expect(/project documentation/i.test(extractionInstruction)).toBe(true)
    expect(/CLAUDE\.md.*README.*docs/i.test(extractionInstruction)).toBe(true)
    expect(/agent summaries/i.test(extractionInstruction)).toBe(true)
    expect(/explicitly stated preferences.*highest priority/i.test(extractionInstruction)).toBe(
      true,
    )
  })

  it('tolerates a fenced write array and caps each extraction at five writes', async () => {
    const writes = Array.from({ length: 6 }, (_, index) => write({ name: `memory-${index + 1}` }))

    await extractMemories(
      { system: 'system', messages: conversation() },
      { repoRoot: tempDir },
      { forkFn: async () => result(`\`\`\`json\n${JSON.stringify(writes)}\n\`\`\``) },
    )

    expect((await loadMemories()).map((memory) => memory.name)).toEqual([
      'memory-1',
      'memory-2',
      'memory-3',
      'memory-4',
      'memory-5',
    ])
    expect(await loadMemoryIndex()).not.toContain('memory-6')
  })

  it('applies nothing for malformed, invalid, or failed fork output', async () => {
    const outputs: Array<ForkResult | Error> = [
      result('not-json'),
      result(JSON.stringify([write({ type: 'invalid' as MemoryWrite['type'] })])),
      { ...result(JSON.stringify([write()])), exitReason: 'fatal_error' },
      new Error('fork exploded'),
    ]

    for (const output of outputs) {
      await extractMemories(
        { system: 'system', messages: conversation() },
        { repoRoot: tempDir },
        {
          forkFn: async () => {
            if (output instanceof Error) throw output
            return output
          },
        },
      )
    }

    expect(await loadMemories()).toEqual([])
    expect(await loadMemoryIndex()).toBe('')
  })

  it('skips disabled, short-conversation, and nested-fork extraction', async () => {
    let calls = 0
    const forkFn = async (): Promise<ForkResult> => {
      calls++
      return result(JSON.stringify([write()]))
    }

    process.env.OCTONOESIS_DISABLE_MEMORY = 'true'
    await extractMemories(
      { system: 'system', messages: conversation() },
      { repoRoot: tempDir },
      { forkFn },
    )
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
    await extractMemories(
      { system: 'system', messages: conversation(3) },
      { repoRoot: tempDir },
      { forkFn },
    )
    process.env.OCTONOESIS_FORK_DEPTH = '1'
    await extractMemories(
      { system: 'system', messages: conversation() },
      { repoRoot: tempDir },
      { forkFn },
    )

    expect(calls).toBe(0)
    expect(await loadMemories()).toEqual([])
  })
})
