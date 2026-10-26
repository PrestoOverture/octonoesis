import { expect, test } from 'bun:test'
import type { CanonicalMessage } from '../../../src/providers/types'
import { createCompactSummaryMessage } from '../../../src/query/compact'
import { buildCompactTaskState, renderCompactTaskState } from '../../../src/query/taskState'

test('preserves exact constraints and observed evidence without claiming verification success', () => {
  const messages: CanonicalMessage[] = [
    { role: 'user', content: 'Do not touch src/auth.ts. Run bun test. Preserve CANARY_中文_42.' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'test-1', name: 'Bash', input: { command: 'bun test' } }],
    },
    {
      role: 'tool',
      tool_use_id: 'test-1',
      content: [
        { type: 'tool_result', tool_use_id: 'test-1', content: 'test failed', is_error: true },
      ],
    },
    { role: 'user', content: '<task-notification>background completed</task-notification>' },
  ]
  const state = buildCompactTaskState(messages)
  expect(state.userRequests).toEqual([messages[0]?.content as string])
  expect(state.evidence).toEqual([
    { toolUseId: 'test-1', tool: 'Bash', input: { command: 'bun test' }, outcome: 'error' },
  ])
  const repeated = buildCompactTaskState([
    messages[0] as CanonicalMessage,
    createCompactSummaryMessage(`${renderCompactTaskState(state)}\nPrevious summary`),
    { role: 'user', content: 'Now fix the failing test.' },
  ])
  expect(repeated.userRequests).toEqual([
    messages[0]?.content as string,
    'Now fix the failing test.',
  ])
  expect(repeated.evidence).toEqual(state.evidence)
})

test('literal state delimiters in user requests survive repeated state serialization', () => {
  const request = 'Keep literal </octo-task-state> and <octo-task-state> unchanged.'
  const state = buildCompactTaskState([{ role: 'user', content: request }])
  const repeated = buildCompactTaskState([
    createCompactSummaryMessage(renderCompactTaskState(state)),
  ])
  expect(repeated.userRequests).toEqual([request])
})

test('protects UUID literals found only in string and structured tool results across repeated compaction', () => {
  const marker = 'RELEASE_12345678-abcd-4321-8765-123456789abc'
  const other = 'abcdef12-3456-7890-abcd-123456789abc'
  const state = buildCompactTaskState([
    { role: 'tool', tool_use_id: 'spec', content: `Only tool output contains ${marker}` },
    {
      role: 'tool',
      tool_use_id: 'check',
      content: [{ type: 'tool_result', tool_use_id: 'check', content: other }],
    },
  ])
  expect(state.toolResultLiterals).toEqual([marker, other])
  const repeated = buildCompactTaskState([
    createCompactSummaryMessage(
      `${renderCompactTaskState(state)}\nLLM prose omitted every identifier.`,
    ),
  ])
  expect(repeated.toolResultLiterals).toEqual([marker, other])
})

test('bounds literal retention and favors recent identifiers', () => {
  const markers = Array.from(
    { length: 50 },
    (_, i) => `ID_${i.toString(16).padStart(8, '0')}-abcd-4321-8765-123456789abc`,
  )
  const state = buildCompactTaskState([
    { role: 'tool', tool_use_id: 'many', content: markers.join('\n') },
  ])
  expect(state.toolResultLiterals).toEqual(markers.slice(-32))
})
