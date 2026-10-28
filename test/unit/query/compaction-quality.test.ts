import { expect, test } from 'bun:test'
import type { CompactResult } from '../../../src/query/compact'
import { evaluateCompactionQuality } from '../../helpers/compactionQuality'

const good: CompactResult = {
  summary:
    'Constraint: preserve exported signature. FACT_42. bun test failed; fix remains pending.',
  pinnedHead: { role: 'user', content: 'Fix the bug' },
  messagesKept: [],
  preCompactTokens: 10000,
  postCompactTokens: 200,
}
const contract = {
  summaryLiterals: ['preserve exported signature', 'FACT_42', 'bun test failed', 'pending'],
  forbiddenSummaryLiterals: ['all tests passed'],
  continuationLiterals: ['FACT_42', 'fixed'],
}

test('evaluates retained task facts and actual continuation separately from token reduction', () => {
  expect(() => evaluateCompactionQuality(good, contract, 'FACT_42 fixed')).not.toThrow()
  expect(() => evaluateCompactionQuality({ ...good, summary: 'Short summary' }, contract)).toThrow(
    'lost required fact',
  )
  expect(() =>
    evaluateCompactionQuality({ ...good, summary: `${good.summary}; all tests passed` }, contract),
  ).toThrow('forbidden claim')
  expect(() => evaluateCompactionQuality(good, contract, 'Done')).toThrow('Continuation lost')
})

test('rejects a smaller history that corrupts tool call/result pairing', () => {
  expect(() =>
    evaluateCompactionQuality(
      { ...good, messagesKept: [{ role: 'tool', tool_use_id: 'missing', content: 'ok' }] },
      contract,
    ),
  ).toThrow('Unpaired tool result')
  expect(() =>
    evaluateCompactionQuality(
      {
        ...good,
        messagesKept: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'missing', name: 'Read', input: { path: 'a.ts' } }],
          },
        ],
      },
      contract,
    ),
  ).toThrow('unanswered tool calls')
})
