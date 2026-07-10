import { describe, expect, it } from 'bun:test'
import {
  FORK_TOOL_ALLOWLISTS,
  ForkInvariantError,
  type ForkOptions,
  type ForkPurpose,
  type ForkResult,
  MEMORY_EXTRACT_WRITE_SCOPE,
  type PreparedFork,
  forkAgent,
  getForkDepth,
  prepareForkInput,
} from '../../../src/providers/fork'
import type { CanonicalTool } from '../../../src/providers/types'
import type { CanonicalMessage } from '../../../src/providers/types'

const baseOptions = (): ForkOptions => ({
  systemPrompt: 'parent-system-prompt',
  messages: [{ role: 'user', content: 'parent message' }],
  tools: [],
  model: 'test-model',
  forkPurpose: 'compact',
})

function setForkDepth(depth: string | undefined): void {
  if (depth === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
  } else {
    process.env.OCTONOESIS_FORK_DEPTH = depth
  }
}

function withForkDepth<T>(depth: string | undefined, run: () => T): T {
  const original = process.env.OCTONOESIS_FORK_DEPTH
  try {
    setForkDepth(depth)
    return run()
  } finally {
    setForkDepth(original)
  }
}

async function withForkDepthAsync<T>(depth: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env.OCTONOESIS_FORK_DEPTH
  try {
    setForkDepth(depth)
    return await run()
  } finally {
    setForkDepth(original)
  }
}

const assertPreparedFork = (prepared: PreparedFork): PreparedFork => prepared
const assertForkResult = (result: ForkResult): ForkResult => result

function tool(name: string): CanonicalTool {
  return { name, description: `${name} tool`, inputSchema: {} }
}

describe('fork recursion invariant', () => {
  it('parses non-negative integer depths and treats absent or invalid values as zero', () => {
    expect(getForkDepth({})).toBe(0)
    expect(getForkDepth({ OCTONOESIS_FORK_DEPTH: '2' })).toBe(2)
    expect(getForkDepth({ OCTONOESIS_FORK_DEPTH: 'invalid' })).toBe(0)
    expect(getForkDepth({ OCTONOESIS_FORK_DEPTH: '-1' })).toBe(0)
    expect(getForkDepth({ OCTONOESIS_FORK_DEPTH: '1.5' })).toBe(0)
    expect(getForkDepth({ OCTONOESIS_FORK_DEPTH: 'Infinity' })).toBe(0)
    expect(getForkDepth({ OCTONOESIS_FORK_DEPTH: '-0' })).toBe(0)
  })

  it('prepares a depth-zero fork with only the child depth override', () => {
    const prepared = withForkDepth('0', () => prepareForkInput(baseOptions()))

    expect(prepared.childEnv).toEqual({ OCTONOESIS_FORK_DEPTH: '1' })
  })

  it('rejects depths one and two with the recursion-depth reason', () => {
    for (const depth of ['1', '2']) {
      let caught: unknown
      try {
        withForkDepth(depth, () => prepareForkInput(baseOptions()))
      } catch (error) {
        caught = error
      }

      expect(caught instanceof ForkInvariantError).toBe(true)
      if (caught instanceof ForkInvariantError) {
        expect(caught.reason).toBe('recursion_depth')
      }
    }
  })

  it('treats an invalid process depth as depth zero', () => {
    const prepared = withForkDepth('invalid', () => prepareForkInput(baseOptions()))

    expect(prepared.childEnv.OCTONOESIS_FORK_DEPTH).toBe('1')
  })
})

describe('fork tool-allowlist invariant', () => {
  it('exports the fixed allowlists and memory-write policy', () => {
    expect(FORK_TOOL_ALLOWLISTS).toEqual({
      compact: [],
      memory_extract: ['Read', 'Grep', 'Glob', 'Write'],
      memory_recall: [],
      tool_summary: [],
    })
    expect(MEMORY_EXTRACT_WRITE_SCOPE).toBe('.octonoesis/memory/')
    expect(Object.values(FORK_TOOL_ALLOWLISTS).flat()).not.toContain('Agent')
    expect(Object.values(FORK_TOOL_ALLOWLISTS).flat()).not.toContain('AgentTool')
  })

  it('rejects every tool for fixed purposes with empty allowlists', () => {
    const purposes: ForkPurpose[] = ['compact', 'memory_recall', 'tool_summary']

    for (const forkPurpose of purposes) {
      const opts = { ...baseOptions(), forkPurpose, tools: [tool('Read')] }
      let caught: unknown
      try {
        withForkDepth('0', () => prepareForkInput(opts))
      } catch (error) {
        caught = error
      }

      expect(caught instanceof ForkInvariantError).toBe(true)
      if (caught instanceof ForkInvariantError) {
        expect(caught.reason).toBe('tool_not_allowed')
      }
    }
  })

  it('accepts exactly the memory-extraction tools and rejects other tools', () => {
    const allowedTools = ['Read', 'Grep', 'Glob', 'Write'].map(tool)
    const prepared = withForkDepth('0', () =>
      prepareForkInput({
        ...baseOptions(),
        forkPurpose: 'memory_extract',
        tools: allowedTools,
      }),
    )

    expect(prepared.tools).toEqual(allowedTools)
    expect(() =>
      withForkDepth('0', () =>
        prepareForkInput({
          ...baseOptions(),
          forkPurpose: 'memory_extract',
          tools: [...allowedTools, tool('Bash')],
        }),
      ),
    ).toThrow(ForkInvariantError)
  })

  it('passes arbitrary skill tools through except agent tools', () => {
    const arbitraryTools = [tool('Bash'), tool('CustomSkillTool')]
    const prepared = withForkDepth('0', () =>
      prepareForkInput({
        ...baseOptions(),
        forkPurpose: 'skill',
        tools: arbitraryTools,
      }),
    )

    expect(prepared.tools).toEqual(arbitraryTools)

    const purposes: ForkPurpose[] = [
      'compact',
      'memory_extract',
      'memory_recall',
      'skill',
      'tool_summary',
    ]
    for (const forkPurpose of purposes) {
      for (const name of ['Agent', 'AgentTool']) {
        let caught: unknown
        try {
          withForkDepth('0', () =>
            prepareForkInput({ ...baseOptions(), forkPurpose, tools: [tool(name)] }),
          )
        } catch (error) {
          caught = error
        }

        expect(caught instanceof ForkInvariantError).toBe(true)
        if (caught instanceof ForkInvariantError) {
          expect(caught.reason).toBe('tool_not_allowed')
        }
      }
    }
  })
})

describe('fork state-isolation invariant', () => {
  it('deep-copies messages so nested mutations cannot cross the fork boundary', () => {
    const messages: CanonicalMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { path: 'src/original.ts' },
          },
        ],
      },
    ]
    const prepared = withForkDepth('0', () => prepareForkInput({ ...baseOptions(), messages }))
    const originalMessage = messages[0]
    const preparedMessage = prepared.messages[0]

    expect(prepared.messages).not.toBe(messages)
    expect(preparedMessage).not.toBe(originalMessage)
    if (originalMessage?.role !== 'assistant' || preparedMessage?.role !== 'assistant') {
      throw new Error('test fixture must contain assistant messages')
    }
    expect(preparedMessage.content).not.toBe(originalMessage.content)
    expect(preparedMessage.content[0]).not.toBe(originalMessage.content[0])

    const originalBlock = originalMessage.content[0]
    const preparedBlock = preparedMessage.content[0]
    if (originalBlock?.type !== 'tool_use' || preparedBlock?.type !== 'tool_use') {
      throw new Error('test fixture must contain tool-use blocks')
    }
    const originalInput = originalBlock.input as { path: string }
    const preparedInput = preparedBlock.input as { path: string }

    preparedInput.path = 'src/fork-change.ts'
    expect(originalInput.path).toBe('src/original.ts')

    originalInput.path = 'src/parent-change.ts'
    expect(preparedInput.path).toBe('src/fork-change.ts')
  })
})

describe('fork budget invariant', () => {
  it('defaults maxTurns to three and passes through an optional token cap', () => {
    const defaultBudget = withForkDepth('0', () => prepareForkInput(baseOptions())).budget
    const explicitBudget = withForkDepth('0', () =>
      prepareForkInput({ ...baseOptions(), maxTurns: 5, maxTokens: 4096 }),
    ).budget

    expect(defaultBudget).toEqual({ maxTurns: 3 })
    expect(explicitBudget).toEqual({ maxTurns: 5, maxTokens: 4096 })
  })

  it('rejects maxTurns values below one or otherwise not at least one', () => {
    for (const maxTurns of [0, -1, Number.NaN]) {
      expect(() =>
        withForkDepth('0', () => prepareForkInput({ ...baseOptions(), maxTurns })),
      ).toThrow(RangeError)
    }
  })

  it('copies budget primitives independently from later options mutations', () => {
    const opts: ForkOptions = { ...baseOptions(), maxTurns: 4, maxTokens: 2048 }
    const prepared = withForkDepth('0', () => prepareForkInput(opts))

    opts.maxTurns = 99
    opts.maxTokens = 99

    expect(prepared.budget).toEqual({ maxTurns: 4, maxTokens: 2048 })
  })
})

describe('fork cache-alignment invariant', () => {
  it('preserves the parent system prompt byte-for-byte without fork decoration', () => {
    const systemPrompt = 'parent\n\ncache-key\u0000\u4fdd\u6301'
    const prepared = withForkDepth('0', () =>
      prepareForkInput({ ...baseOptions(), systemPrompt, forkPurpose: 'tool_summary' }),
    )

    expect(prepared.systemPrompt).toBe(systemPrompt)
    expect(prepared.purpose).toBe('tool_summary')
    expect(prepared.model).toBe('test-model')
  })
})

describe('forkAgent stub', () => {
  it('returns a zero-usage mock result within its prepared budget', async () => {
    const opts: ForkOptions = {
      ...baseOptions(),
      maxTurns: 1,
      maxTokens: 512,
      signal: new AbortController().signal,
    }
    const prepared = assertPreparedFork(withForkDepth('0', () => prepareForkInput(opts)))
    const result = assertForkResult(await withForkDepthAsync('0', () => forkAgent(opts)))

    expect(result).toEqual({
      text: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      turns: 0,
      exitReason: 'completed',
    })
    expect(result.turns <= prepared.budget.maxTurns).toBe(true)
  })

  it('enforces preparation invariants on every call', async () => {
    await expect(withForkDepthAsync('1', () => forkAgent(baseOptions()))).rejects.toThrow(
      ForkInvariantError,
    )
    await expect(
      withForkDepthAsync('0', () =>
        forkAgent({ ...baseOptions(), forkPurpose: 'skill', tools: [tool('Agent')] }),
      ),
    ).rejects.toThrow(ForkInvariantError)
    await expect(
      withForkDepthAsync('0', () => forkAgent({ ...baseOptions(), maxTurns: 0 })),
    ).rejects.toThrow(RangeError)
  })
})
