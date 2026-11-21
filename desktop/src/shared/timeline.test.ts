import { expect, test } from 'bun:test'
import type { CheckpointTimeline } from '../../../src/host/protocol'
import { rewindPlan, timelineRows } from './timeline'

const timeline: CheckpointTimeline = {
  entries: [
    { seq: 1, ts: 't1', tool: 'Edit', path: 'a.ts', created: false },
    { seq: 2, ts: 't2', tool: 'Write', path: 'new.ts', created: true },
    { seq: 3, ts: 't3', tool: 'Edit', path: 'a.ts', created: false },
    { seq: 4, ts: 't4', tool: 'Edit', path: 'new.ts', created: false },
  ],
  commands: [
    { afterSeq: 0, ts: 't0', command: 'ls' },
    { afterSeq: 2, ts: 't2b', command: 'bun test' },
  ],
}

test('rows run newest first with each command above the change it followed', () => {
  expect(
    timelineRows(timeline).map((row) =>
      row.kind === 'change' ? `#${row.entry.seq}` : `$ ${row.command}`,
    ),
  ).toEqual(['#4', '#3', '$ bun test', '#2', '#1', '$ ls'])
})

test('rewind plan: one action per file from its earliest change in range, commands kept', () => {
  expect(rewindPlan(timeline, 2)).toEqual({
    files: [
      { path: 'new.ts', action: 'delete' },
      { path: 'a.ts', action: 'restore' },
    ],
    commands: ['bun test'],
  })
  expect(rewindPlan(timeline, 4)).toEqual({
    files: [{ path: 'new.ts', action: 'restore' }],
    commands: [],
  })
  expect(rewindPlan(timeline, 1).commands).toEqual(['ls', 'bun test'])
})
