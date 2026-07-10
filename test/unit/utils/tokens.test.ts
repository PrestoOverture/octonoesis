import { afterEach, describe, expect, it } from 'bun:test'
import type { CanonicalMessage, Usage } from '../../../src/providers/types'
import {
  contextTokensWithEstimation,
  estimateMessagesTokens,
  estimateTextTokens,
  getCompactThreshold,
  getContextWindowSize,
  totalTokensFromUsage,
} from '../../../src/utils/tokens'

const originalThreshold = process.env.OCTONOESIS_COMPACT_THRESHOLD

afterEach(() => {
  if (originalThreshold === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_COMPACT_THRESHOLD')
  } else {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = originalThreshold
  }
})

describe('token accounting', () => {
  it('estimates text with the shared four-characters-per-token formula', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('a')).toBe(1)
    expect(estimateTextTokens('abcd')).toBe(1)
    expect(estimateTextTokens('abcde')).toBe(2)
  })

  it('counts canonical message payloads and fixed message overhead', () => {
    const toolInput = { path: 'src/example.ts' }
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'abcd' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'abcde' },
          { type: 'tool_use', id: 'call-1', name: 'Read', input: toolInput },
        ],
      },
      {
        role: 'tool',
        tool_use_id: 'call-1',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '12345678' }],
      },
    ]

    expect(estimateMessagesTokens(messages)).toBe(
      3 * 4 +
        estimateTextTokens('abcd') +
        estimateTextTokens('abcde') +
        estimateTextTokens(JSON.stringify(toolInput)) +
        estimateTextTokens('12345678'),
    )
  })

  it('anchors snapshot counts to API usage including cached input tokens', () => {
    const usage: Usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    }
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'already covered' },
      { role: 'assistant', content: [{ type: 'text', text: 'new output' }] },
      { role: 'tool', tool_use_id: 'call-1', content: 'new tool result' },
    ]

    expect(totalTokensFromUsage(usage)).toBe(65)
    expect(contextTokensWithEstimation(messages, { tokens: 65, coveredCount: 1 })).toBe(
      65 + estimateMessagesTokens(messages.slice(1)),
    )
    expect(contextTokensWithEstimation(messages)).toBe(estimateMessagesTokens(messages))
  })

  it('uses conservative model-prefix windows and the reserved compact threshold', () => {
    expect(getContextWindowSize('claude-sonnet-4-6')).toBe(200_000)
    expect(getContextWindowSize('gpt-5-nano')).toBe(400_000)
    expect(getContextWindowSize('gpt-4o-mini')).toBe(128_000)
    expect(getContextWindowSize('other-model')).toBe(128_000)
    expect(getCompactThreshold('claude-haiku-4-5-20251001')).toBe(167_000)
  })

  it('accepts only a positive integer absolute threshold override', () => {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1234'
    expect(getCompactThreshold('claude-sonnet-4-6')).toBe(1234)

    process.env.OCTONOESIS_COMPACT_THRESHOLD = '-1'
    expect(getCompactThreshold('claude-sonnet-4-6')).toBe(167_000)

    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1.5'
    expect(getCompactThreshold('claude-sonnet-4-6')).toBe(167_000)
  })
})
