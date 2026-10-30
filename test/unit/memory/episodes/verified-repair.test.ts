import { expect, test } from 'bun:test'
import {
  type JournalEventWithLine,
  type StoredJournalEvent,
  segmentJournal,
} from '../../../../src/memory/episodes/segment'

const common = { session_id: 'repair', ts: '2026-01-01T00:00:00Z' }
const failure: StoredJournalEvent = {
  ...common,
  kind: 'tool',
  tool: 'Bash',
  cmd: 'bun test',
  input_digest: 'fail',
  outcome: 'success',
  error_class: null,
  duration_ms: 1,
  exit_code: 1,
  fingerprints: [
    {
      coarse: 'test|AssertionError',
      medium: 'test|AssertionError|case.ts',
      fine: 'test|AssertionError|case.ts|first',
    },
  ],
  error_excerpt: 'AssertionError: expected one call, got two',
}
const edit: StoredJournalEvent = {
  ...common,
  kind: 'tool',
  tool: 'Edit',
  input_digest: 'edit',
  outcome: 'success',
  error_class: null,
  duration_ms: 1,
  path: 'case.ts',
  fix_diff: '--- before\nstart()\n+++ after\nshare()',
}
const verify: StoredJournalEvent = {
  ...common,
  kind: 'verify',
  command: 'bun test',
  verdict: 'PASS',
  exit_code: 0,
  stale: false,
  fingerprints: [],
}
const segment = (events: StoredJournalEvent[]) =>
  segmentJournal(events.map((event, i): JournalEventWithLine => ({ event, line: i + 1 })))

test('signature disappearance during a failed verification is not a resolved repair', () => {
  const events = [failure, edit, { ...verify, verdict: 'FAIL' as const, exit_code: 1 }]
  expect(segment(events)[0]?.outcome).toBe('abandoned')
  const resolved = segment([...events, verify])[0]
  expect(resolved?.outcome).toBe('resolved')
  expect(resolved?.journal_line_range.end).toBe(4)
})

test('unrelated successful commands and stale verifications cannot resolve an episode', () => {
  for (const unrelated of [
    { ...verify, command: 'bun lint' },
    { ...verify, stale: true },
    { ...failure, cmd: 'git status', exit_code: 0, fingerprints: [] },
  ])
    expect(segment([failure, edit, unrelated])[0]?.outcome).toBe('abandoned')
})

test('segmentation carries actual error and successful edit evidence to the distiller', () => {
  const episode = segment([failure, edit, verify])[0]
  expect(episode?.evidence?.errorExcerpt).toBe(failure.error_excerpt)
  expect(episode?.evidence?.fixDiff).toContain(edit.fix_diff ?? '')
})
