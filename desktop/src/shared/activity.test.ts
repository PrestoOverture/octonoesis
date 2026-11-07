import { expect, test } from 'bun:test'
import { type ToolItem, activityBlocks, summarizeGroup } from './activity'
import type { Item } from './transcript'

const tool = (
  id: string,
  name: string,
  argument: string,
  status: ToolItem['status'] = 'done',
  summary?: string,
): ToolItem => ({ kind: 'tool', id, name, argument, status, ...(summary ? { summary } : {}) })

test('consecutive tool calls collapse into one group; text and single calls stay separate', () => {
  const items: Item[] = [
    { kind: 'assistant', text: 'Reading first.' },
    tool('1', 'Read', 'src/a.ts'),
    tool('2', 'Grep', 'needle src'),
    { kind: 'assistant', text: 'Fixing.' },
    tool('3', 'Edit', 'src/a.ts', 'done', '+2 −1 lines'),
  ]
  expect(activityBlocks(items).map((block) => block.kind)).toEqual([
    'item',
    'group',
    'item',
    'tool',
  ])
  const group = activityBlocks(items)[1]
  expect(group).toMatchObject({ kind: 'group', index: 1, live: false })
})

test('failed calls never collapse: they split the run and stand alone', () => {
  const blocks = activityBlocks([
    tool('1', 'Read', 'a'),
    tool('2', 'Read', 'b'),
    tool('3', 'Bash', 'bun test', 'error', 'exit 1'),
    tool('4', 'Read', 'c'),
    tool('5', 'Read', 'd'),
  ])
  expect(blocks.map((block) => block.kind)).toEqual(['group', 'tool', 'group'])
  expect(blocks[1]).toMatchObject({ kind: 'tool', tool: { id: '3', status: 'error' } })
})

test('a running call marks its group live and is named in the summary', () => {
  const tools = [tool('1', 'Read', 'a'), tool('2', 'Bash', 'bun test', 'running')]
  expect(activityBlocks(tools)[0]).toMatchObject({ kind: 'group', live: true })
  expect(summarizeGroup(tools)).toMatchObject({
    title: 'Ran',
    running: { name: 'Bash', argument: 'bun test' },
    details: ['read 1 file', 'ran 1 command'],
  })
})

test('group summary: one edited file shows its path and summed +/−; reads count as explored', () => {
  expect(
    summarizeGroup([
      tool('1', 'Read', 'src/a.ts'),
      tool('2', 'Edit', 'src/a.ts', 'done', '+2 −1 lines'),
      tool('3', 'Edit', 'src/a.ts', 'done', '+1 −0 lines'),
    ]),
  ).toEqual({
    title: 'Edited',
    file: 'src/a.ts',
    added: 3,
    removed: 1,
    details: ['read 1 file'],
    running: undefined,
  })
  expect(
    summarizeGroup([
      tool('1', 'Edit', 'a', 'done', '+1 −1 lines'),
      tool('2', 'Write', 'b', 'done', '4 lines'),
    ]),
  ).toMatchObject({ title: 'Edited', added: 5, removed: 1, details: ['edited 2 files'] })
  expect(
    summarizeGroup([tool('1', 'Read', 'a'), tool('2', 'Glob', '*.ts'), tool('3', 'Grep', 'x')]),
  ).toMatchObject({ title: 'Explored', details: ['read 1 file', 'searched 2 patterns'] })
})
