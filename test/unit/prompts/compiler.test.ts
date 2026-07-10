import { describe, expect, it } from 'bun:test'
import {
  type CompiledContext,
  type ContextBudget,
  ContextBudgetError,
  type ContextPriority,
  type ContextSource,
  DEFAULT_CONTEXT_BUDGET,
  compileContext,
  estimateTokens,
} from '../../../src/prompts/compiler'

const unlimitedBudget: ContextBudget = {
  totalSystemPromptCap: 1000,
  perSourceCaps: {},
}

const assertCompiledContext = (context: CompiledContext): CompiledContext => context
const assertPriority = (priority: ContextPriority): ContextPriority => priority

function source(
  id: string,
  channel: ContextSource['channel'],
  priority: ContextSource['priority'],
  content: string,
  tokens?: number,
): ContextSource {
  return { id, channel, priority, content, ...(tokens === undefined ? {} : { tokens }) }
}

describe('ContextCompiler', () => {
  it('estimates tokens as characters divided by four, rounded up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('routes sources by channel while preserving input order within each channel', () => {
    const result = compileContext(
      [
        source('stable-1', 'systemStable', 'critical', 'stable one'),
        source('volatile-1', 'preamble', 'medium', 'volatile one'),
        source('stable-2', 'systemStable', 'medium', 'stable two'),
        source('volatile-2', 'preamble', 'medium', 'volatile two'),
      ],
      unlimitedBudget,
    )

    expect(result.systemStable).toBe('stable one\n\nstable two')
    expect(result.preamble).toBe('volatile one\n\nvolatile two')
    expect(result.totalTokens).toBe(
      estimateTokens(result.systemStable) + estimateTokens(result.preamble),
    )
    expect(result.dropped).toEqual([])
  })

  it('exports the documented default source caps and total cap', () => {
    expect(DEFAULT_CONTEXT_BUDGET).toEqual({
      totalSystemPromptCap: 32_000,
      perSourceCaps: {
        static_prompt: 8_000,
        claude_md: 12_000,
        memory_index: 4_000,
        relevant_memories: 4_000,
        active_rules: 2_000,
        skill_catalog: 2_000,
        mcp_instructions: 2_000,
        dynamic_suffix: 1_000,
      },
    })
  })

  it('tail-truncates sources in both channels at their per-source caps', () => {
    const result = compileContext(
      [
        source('stable', 'systemStable', 'critical', 'abcdefghij'),
        source('volatile', 'preamble', 'medium', '123456789'),
      ],
      {
        totalSystemPromptCap: 100,
        perSourceCaps: { stable: 2, volatile: 1 },
      },
    )

    expect(result.systemStable).toBe('abcdefgh')
    expect(result.preamble).toBe('1234')
    expect(result.dropped).toEqual(['stable', 'volatile'])
  })

  it('uses a tokens override instead of falling back to character estimation', () => {
    const content = 'abcdefghijklmnopqrst'
    const result = compileContext(
      [
        source('estimated', 'systemStable', 'high', content),
        source('overridden', 'systemStable', 'high', content, 2),
      ],
      {
        totalSystemPromptCap: 100,
        perSourceCaps: { estimated: 3, overridden: 3 },
      },
    )

    expect(result.systemStable).toBe(`abcdefghijkl\n\n${content}`)
    expect(result.dropped).toEqual(['estimated'])
  })

  it('uses tokens overrides when enforcing the stable total cap', () => {
    const underestimated = compileContext(
      [source('underestimated', 'systemStable', 'low', 'U'.repeat(40), 1)],
      { totalSystemPromptCap: 1, perSourceCaps: {} },
    )
    const overestimated = compileContext(
      [source('overestimated', 'systemStable', 'low', 'OOOO', 10)],
      { totalSystemPromptCap: 1, perSourceCaps: {} },
    )

    expect(underestimated.systemStable).toBe('U'.repeat(40))
    expect(underestimated.dropped).toEqual([])
    expect(underestimated.totalTokens).toBe(10)
    expect(overestimated.systemStable).toBe('')
    expect(overestimated.dropped).toEqual(['overestimated'])
  })

  it('omits empty sources without reporting them as dropped', () => {
    const result = compileContext(
      [
        source('empty-stable', 'systemStable', 'critical', ''),
        source('stable', 'systemStable', 'critical', 'stable'),
        source('empty-volatile', 'preamble', 'medium', ''),
        source('volatile', 'preamble', 'medium', 'volatile'),
      ],
      unlimitedBudget,
    )

    expect(result.systemStable).toBe('stable')
    expect(result.preamble).toBe('volatile')
    expect(result.dropped).toEqual([])
  })

  it('drops low-priority stable sources in reverse input order before touching medium', () => {
    const result = compileContext(
      [
        source('critical', 'systemStable', 'critical', 'CCCC'),
        source('medium', 'systemStable', 'medium', 'MMMM'),
        source('low-1', 'systemStable', 'low', '1111'),
        source('low-2', 'systemStable', 'low', '2222'),
        source('low-3', 'systemStable', 'low', '3333'),
      ],
      { totalSystemPromptCap: 4, perSourceCaps: {} },
    )

    expect(result.systemStable).toBe('CCCC\n\nMMMM\n\n1111')
    expect(result.dropped).toEqual(['low-2', 'low-3'])
    expect(estimateTokens(result.systemStable) <= 4).toBe(true)
  })

  it('drops medium sources in reverse input order only after low sources are exhausted', () => {
    const result = compileContext(
      [
        source('critical', 'systemStable', 'critical', 'CCCC'),
        source('medium-1', 'systemStable', 'medium', '1111'),
        source('medium-2', 'systemStable', 'medium', '2222'),
        source('low', 'systemStable', 'low', 'LLLL'),
      ],
      { totalSystemPromptCap: 3, perSourceCaps: {} },
    )

    expect(result.systemStable).toBe('CCCC\n\n1111')
    expect(result.dropped).toEqual(['medium-2', 'low'])
    expect(estimateTokens(result.systemStable) <= 3).toBe(true)
  })

  it('tail-truncates high sources in reverse input order after lower tiers are dropped', () => {
    const result = compileContext(
      [
        source('critical', 'systemStable', 'critical', 'CCCC'),
        source('high-1', 'systemStable', 'high', '11111111'),
        source('high-2', 'systemStable', 'high', '22222222'),
        source('medium', 'systemStable', 'medium', 'MMMM'),
        source('low', 'systemStable', 'low', 'LLLL'),
      ],
      { totalSystemPromptCap: 5, perSourceCaps: {} },
    )

    expect(result.systemStable).toBe('CCCC\n\n11111111\n\n2222')
    expect(result.systemStable).toContain('11111111')
    expect(result.dropped).toEqual(['high-2', 'medium', 'low'])
    expect(estimateTokens(result.systemStable) <= 5).toBe(true)
  })

  it('throws ContextBudgetError naming system critical sources when they alone overflow', () => {
    const compile = () =>
      compileContext(
        [
          source('critical-one', 'systemStable', 'critical', '11111111'),
          source('zeroed-critical', 'systemStable', 'critical', 'ZZZZ'),
          source('volatile-critical', 'preamble', 'critical', 'not part of the stable cap'),
          source('critical-two', 'systemStable', 'critical', '22222222'),
        ],
        { totalSystemPromptCap: 4, perSourceCaps: { 'zeroed-critical': 0 } },
      )

    expect(compile).toThrow(ContextBudgetError)
    expect(compile).toThrow('critical-one')
    expect(compile).toThrow('critical-two')
    expect(compile).not.toThrow('zeroed-critical')
    expect(compile).not.toThrow('volatile-critical')
  })

  it('does not apply the stable total cap to preamble sources', () => {
    const volatileContent = 'V'.repeat(40)
    const result = compileContext(
      [
        source('critical', 'systemStable', 'critical', 'CCCC'),
        source('volatile', 'preamble', 'medium', volatileContent),
      ],
      { totalSystemPromptCap: 1, perSourceCaps: {} },
    )

    expect(result.systemStable).toBe('CCCC')
    expect(result.preamble).toBe(volatileContent)
    expect(result.dropped).toEqual([])
    expect(result.totalTokens).toBe(11)
  })

  it('reports a source changed by both cap passes only once', () => {
    const result = compileContext(
      [
        source('critical', 'systemStable', 'critical', 'CCCC'),
        source('high', 'systemStable', 'high', 'abcdefghijklmnopqrst'),
      ],
      {
        totalSystemPromptCap: 3,
        perSourceCaps: { high: 4 },
      },
    )

    expect(result.systemStable).toBe('CCCC\n\nabcdef')
    expect(result.dropped).toEqual(['high'])
  })

  it('produces byte-identical channel strings for identical inputs', () => {
    const sources = [
      source('critical', 'systemStable', assertPriority('critical'), 'stable'),
      source('volatile', 'preamble', 'medium', 'volatile'),
    ]
    const originalSources = structuredClone(sources)

    const first = assertCompiledContext(compileContext(sources, unlimitedBudget))
    const second = compileContext(sources, unlimitedBudget)

    expect(first.systemStable).toBe(second.systemStable)
    expect(first.preamble).toBe(second.preamble)
    expect(sources).toEqual(originalSources)
  })
})
