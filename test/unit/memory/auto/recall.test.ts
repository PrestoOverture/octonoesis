import { afterEach, describe, expect, it } from 'bun:test'
import { findRelevantMemories } from '../../../../src/memory/auto/recall'
import type { MemoryFile } from '../../../../src/memory/auto/types'
import type { ForkOptions, ForkResult } from '../../../../src/providers/fork'

const originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY

afterEach(() => {
  if (originalDisableMemory === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
  } else {
    process.env.OCTONOESIS_DISABLE_MEMORY = originalDisableMemory
  }
})

function memory(index: number): MemoryFile {
  return {
    name: `memory-${index}`,
    description: `Description ${index}`,
    type: index % 2 === 0 ? 'project' : 'user',
    content: `Body ${index}`,
    path: `/tmp/memory-${index}.md`,
    mtime: index,
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

describe('auto-memory recall', () => {
  it('filters unknown names, preserves ranking, and caps results at five', async () => {
    const memories = Array.from({ length: 7 }, (_, index) => memory(index + 1))
    let received: ForkOptions | undefined
    const forkFn = async (opts: ForkOptions): Promise<ForkResult> => {
      received = opts
      return result(
        JSON.stringify([
          'memory-7',
          'unknown',
          'memory-6',
          'memory-5',
          'memory-4',
          'memory-3',
          'memory-2',
        ]),
      )
    }

    const recalled = await findRelevantMemories('Which preferences apply?', memories, {
      systemPrompt: 'stable parent prompt',
      forkFn,
    })

    expect(recalled.map((entry) => entry.name)).toEqual([
      'memory-7',
      'memory-6',
      'memory-5',
      'memory-4',
      'memory-3',
    ])
    expect(received?.forkPurpose).toBe('memory_recall')
    expect(received?.systemPrompt).toBe('stable parent prompt')
    expect(received?.tools).toEqual([])
    expect(received?.maxTurns).toBe(1)
    expect(received?.timeoutMs).toBe(15_000)
    expect(received && 'model' in received).toBe(false)
    expect(JSON.stringify(received?.messages)).toContain('memory-1: Description 1')
    expect(JSON.stringify(received?.messages)).toContain('Which preferences apply?')
  })

  it('tolerates fenced JSON and degrades malformed or failed forks to no recall', async () => {
    const memories = [memory(1), memory(2)]
    const fenced = await findRelevantMemories('query', memories, {
      forkFn: async () => result('```json\n["memory-2"]\n```'),
    })
    const malformed = await findRelevantMemories('query', memories, {
      forkFn: async () => result('not-json'),
    })
    const failed = await findRelevantMemories('query', memories, {
      forkFn: async () => ({ ...result('[]'), exitReason: 'fatal_error' }),
    })

    expect(fenced.map((entry) => entry.name)).toEqual(['memory-2'])
    expect(malformed).toEqual([])
    expect(failed).toEqual([])
  })

  it('does not fork with zero memories or when memory is disabled', async () => {
    let calls = 0
    const forkFn = async (): Promise<ForkResult> => {
      calls++
      return result('[]')
    }

    expect(await findRelevantMemories('query', [], { forkFn })).toEqual([])
    process.env.OCTONOESIS_DISABLE_MEMORY = 'yes'
    expect(await findRelevantMemories('query', [memory(1)], { forkFn })).toEqual([])
    expect(calls).toBe(0)
  })
})
