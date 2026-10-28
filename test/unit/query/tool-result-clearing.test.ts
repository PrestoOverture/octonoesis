import { afterEach, expect, test } from 'bun:test'
import type { CanonicalMessage } from '../../../src/providers/types'
import { clearOldToolResults } from '../../../src/query/toolResultClearing'
import { restoreEnv } from '../../helpers/env'

const threshold = process.env.OCTONOESIS_COMPACT_THRESHOLD
afterEach(() => restoreEnv('OCTONOESIS_COMPACT_THRESHOLD', threshold))

function history(): CanonicalMessage[] {
  return [
    { role: 'user', content: 'Keep exact constraint CANARY_42' },
    ...['Read', 'Grep', 'Bash', 'Read', 'Glob', 'Read', 'Read', 'Read'].flatMap(
      (name, i): CanonicalMessage[] => [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name, input: { path: 'fixture.txt' } }],
        },
        {
          role: 'tool',
          tool_use_id: `t${i}`,
          content:
            i === 3
              ? [
                  {
                    type: 'tool_result',
                    tool_use_id: `t${i}`,
                    content: 'failed'.repeat(2000),
                    is_error: true,
                  },
                ]
              : 'large output '.repeat(1000),
        },
      ],
    ),
  ]
}

test('clears old reproducible successes while preserving errors, recent results and pairing', () => {
  process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
  const input = history()
  const original = structuredClone(input)
  const result = clearOldToolResults(input, 'spark', { keepRecent: 3 })
  expect(result.clearedCount).toBe(3)
  expect(input).toEqual(original)
  for (const index of [2, 4, 10])
    expect(JSON.stringify(result.messages[index])).toContain('<octo-cleared-tool-result>')
  for (const index of [0, 1, 6, 8, 12, 14, 16]) expect(result.messages[index]).toEqual(input[index])
  expect(clearOldToolResults(result.messages, 'spark', { keepRecent: 3 }).clearedCount).toBe(0)
})

test('respects opt-out, pressure threshold and minimum output size', () => {
  const input = history()
  expect(clearOldToolResults(input, 'spark', { enabled: false }).messages).toBe(input)
  process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000000'
  expect(clearOldToolResults(input, 'spark').clearedCount).toBe(0)
  process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
  expect(clearOldToolResults(input, 'spark', { minTokens: 100000 }).clearedCount).toBe(0)
})

test('retains opaque identifiers when clearing a tool result before summarization', () => {
  process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
  const input = history()
  const message = input[2]
  if (!message || message.role !== 'tool') throw new Error('missing fixture result')
  const marker = 'RELEASE_12345678-abcd-4321-8765-123456789abc'
  message.content = `${message.content}\n${marker}`
  const result = clearOldToolResults(input, 'spark', { keepRecent: 3 })
  expect(JSON.stringify(result.messages[2])).toContain('<octo-cleared-tool-result>')
  expect(JSON.stringify(result.messages[2])).toContain(marker)
})
