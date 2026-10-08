import { expect, test } from 'bun:test'
import { primaryArg, summarizeToolResult } from '../../../src/query/toolSummary'

const argumentsTable: [string, unknown, string][] = [
  ...['Read', 'Edit', 'Write'].map(
    (name) => [name, { path: 'src/x.ts' }, 'src/x.ts'] as [string, unknown, string],
  ),
  ['Grep', { pattern: 'needle' }, 'needle'],
  ['Grep', { pattern: 'needle', path: 'src' }, 'needle src'],
  ['Glob', { pattern: '**/*.ts' }, '**/*.ts'],
  ['Bash', { command: 'echo first\necho second' }, 'echo first'],
  ['TodoWrite', { todos: [] }, ''],
  ['Agent', { description: 'inspect code' }, 'inspect code'],
  ['Skill', { skill: 'review' }, 'review'],
  ['SendMessage', { message: 'body', agentId: 'agent-1' }, 'agent-1'],
  ['mcp__server__tool', { n: 3, query: 'first', other: 'second' }, 'first'],
  ['Unknown', { n: 3, text: 'hello\nworld' }, 'hello'],
  ['Unknown', { n: 3 }, ''],
  ['Unknown', null, ''],
]
for (const [name, input, expected] of argumentsTable)
  test(`primary argument ${name}: ${expected}`, () => {
    expect(primaryArg(name, input)).toBe(expected)
  })
const summaries: [string, unknown, string, string | undefined, boolean][] = [
  ['Read', {}, '1\tone', '1 line', false],
  ['Read', {}, '1\tone\n2\ttwo\n3\tthree', '3 lines', false],
  ['Grep', {}, 'a.ts:\n  1: one', '1 match in 1 file', false],
  ['Grep', {}, 'a.ts:\n  1: one\n  2: two\n\nb.ts:\n  1: one', '3 matches in 2 files', false],
  ['Grep', {}, 'No matches found.', 'no matches', false],
  [
    'Grep',
    {},
    'a.ts:\n  1: one\n... [Output truncated to stay under 30000 character limit]',
    '1+ matches in 1 file',
    false,
  ],
  ['Glob', {}, '[]', '0 files', false],
  ['Glob', {}, '["a"]', '1 file', false],
  ['Glob', {}, '["a","b"]', '2 files', false],
  ['Bash', {}, '{"code":0,"stdout":"","stderr":""}', 'exit 0', false],
  ['Bash', {}, '{"code":1,"stdout":"","stderr":""}', 'exit 1', true],
  ['Bash', {}, '{"task_id":"t1","status":"running"}', 'started t1', false],
  ['Edit', { old_string: 'a\nb', new_string: 'c' }, 'edited', '+1 −2 lines', false],
  ['Edit', { old_string: 'a', new_string: '' }, 'edited', '+0 −1 lines', false],
  ['Write', { content: 'one' }, 'created', '1 line', false],
  ['Write', { content: 'one\ntwo' }, 'created', '2 lines', false],
  ['Write', { content: '' }, 'created', '0 lines', false],
  [
    'TodoWrite',
    { todos: [{ status: 'completed' }, { status: 'pending' }] },
    'updated',
    '2 todos, 1 done',
    false,
  ],
  ['TodoWrite', { todos: [{ status: 'completed' }] }, 'updated', '1 todo, 1 done', false],
  ['Agent', {}, 'response', 'done', false],
  ['Agent', {}, '{"status":"running","agentId":"a"}', 'running in background', false],
  ...['Skill', 'SendMessage', 'mcp__server__tool', 'Unknown'].map(
    (name) =>
      [name, {}, 'result', undefined, false] as [string, unknown, string, undefined, boolean],
  ),
]
for (const [name, input, content, summary, failed] of summaries)
  test(`${name} summary: ${summary}`, () => {
    expect(summarizeToolResult(name, input, { ok: true, content })).toEqual({ summary, failed })
  })
for (const name of [...new Set(argumentsTable.map((row) => row[0]))])
  test(`${name} error`, () => {
    expect(
      summarizeToolResult(
        name,
        {},
        { ok: false, content: '{"error":"must_read_first: read first"}' },
      ),
    ).toEqual({ failed: true, summary: 'must_read_first' })
  })
test('error prefixes, fallback, and engine cancellation', () => {
  for (const [error, summary] of [
    ['blocked_command: denied', 'blocked_command'],
    ['x'.repeat(60), 'x'.repeat(40)],
    ['Tool execution cancelled by user.', 'cancelled'],
  ]) {
    expect(
      summarizeToolResult('Bash', {}, { ok: false, content: JSON.stringify({ error }) }),
    ).toEqual({ failed: true, summary })
  }
  expect(
    summarizeToolResult('Read', {}, { ok: false, content: 'Tool execution cancelled by user.' })
      .summary,
  ).toBe('cancelled')
})
