import { describe, expect, it } from 'bun:test'
import { type StoredJournalEvent, segmentJournal } from '../../../../src/memory/episodes/segment'

describe('Episode Segmentation State Machine', () => {
  it('should segment a simple failure-to-fix-to-resolve arc into a resolved episode', () => {
    const events = [
      {
        line: 1,
        event: {
          kind: 'user' as const,
          ts: '2026-06-20T10:00:00.000Z',
          session_id: 'sess-123',
          digest: 'user-task-digest',
          cancel: false,
        },
      },
      {
        line: 2,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:01:00.000Z',
          session_id: 'sess-123',
          tool: 'Bash',
          input_digest: 'digest-run-tests',
          outcome: 'failure' as const,
          error_class: 'TypeError',
          duration_ms: 1000,
          cmd: 'bun test test/buggy.test.ts',
          fingerprints: [
            {
              coarse: 'bash|TypeError',
              medium: 'bash|TypeError|src/buggy.ts',
              fine: "bash|TypeError|src/buggy.ts|evaluating 'user.name'",
            },
          ],
        },
      },
      {
        line: 3,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:02:00.000Z',
          session_id: 'sess-123',
          tool: 'Edit',
          input_digest: 'digest-edit-file',
          outcome: 'success' as const,
          error_class: null,
          duration_ms: 500,
          path: 'src/buggy.ts',
        },
      },
      {
        line: 4,
        event: {
          kind: 'verify' as const,
          ts: '2026-06-20T10:03:00.000Z',
          session_id: 'sess-123',
          verdict: 'PASS' as const,
          fingerprints: [],
          command: 'bun test',
          exit_code: 0,
          stale: false,
        },
      },
    ]

    const episodes = segmentJournal(events)
    expect(episodes.length).toBe(1)

    const ep = episodes[0]
    expect(ep).toBeDefined()
    expect(ep?.id).toBe('ep_0001')
    expect(ep?.outcome).toBe('resolved')
    expect(ep?.failure.error_class).toBe('TypeError')
    expect(ep?.failure.cmd).toBe('bun test test/buggy.test.ts')
    expect(ep?.failure.signature).toBe("bash|TypeError|src/buggy.ts|evaluating 'user.name'")
    expect(ep?.fix_candidates?.[0]?.path).toBe('src/buggy.ts')
    expect(ep?.fix_candidates?.[0]?.role).toBe('direct')
    expect(ep?.attribution.status).toBe('single_direct')
    expect(ep?.attribution.primary).toBe('src/buggy.ts')
    expect(ep?.attribution.confidence).toBe(0.9)
    expect(ep?.verification?.cmd).toBe('bun test')
    expect(ep?.verification?.exit_code).toBe(0)
    expect(ep?.journal_line_range.start).toBe(2)
    expect(ep?.journal_line_range.end).toBe(4)
    expect(ep?.value_score).toBe(1.0)
    expect(ep?.is_excluded).toBe(false)
  })

  it('should transition open failures to abandoned at session end', () => {
    const events = [
      {
        line: 1,
        event: {
          kind: 'user' as const,
          ts: '2026-06-20T10:00:00.000Z',
          session_id: 'sess-123',
          digest: 'user-task-digest',
          cancel: false,
        },
      },
      {
        line: 2,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:01:00.000Z',
          session_id: 'sess-123',
          tool: 'Bash',
          input_digest: 'digest-run-tests',
          outcome: 'failure' as const,
          error_class: 'SyntaxError',
          duration_ms: 1000,
          fingerprints: [
            {
              coarse: 'bash|SyntaxError',
              medium: 'bash|SyntaxError|src/index.ts',
              fine: 'bash|SyntaxError|src/index.ts|unexpected token',
            },
          ],
        },
      },
    ]

    const episodes = segmentJournal(events)
    expect(episodes.length).toBe(1)

    const ep = episodes[0]
    expect(ep?.outcome).toBe('abandoned')
    expect(ep?.is_excluded).toBe(true)
    expect(ep?.exclusion_reason).toBe('abandoned')
    expect(ep?.journal_line_range.start).toBe(2)
    expect(ep?.journal_line_range.end).toBe(2)
  })

  it('should support pivot detection and abandon failures if no related activity occurs', () => {
    const events = [
      {
        line: 1,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:01:00.000Z',
          session_id: 'sess-123',
          tool: 'Bash',
          input_digest: 'digest-1',
          outcome: 'failure' as const,
          error_class: 'TypeError',
          duration_ms: 1000,
          fingerprints: [
            {
              coarse: 'bash|TypeError',
              medium: 'bash|TypeError|src/bug.ts',
              fine: 'bash|TypeError|src/bug.ts|error',
            },
          ],
        },
      },
      {
        line: 2,
        event: {
          kind: 'user' as const,
          ts: '2026-06-20T10:02:00.000Z',
          session_id: 'sess-123',
          digest: 'new-unrelated-prompt',
          cancel: false,
        },
      },
      {
        line: 3,
        event: {
          kind: 'turn' as const,
          ts: '2026-06-20T10:03:00.000Z',
          session_id: 'sess-123',
          turn: 1,
        },
      },
      {
        line: 4,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:04:00.000Z',
          session_id: 'sess-123',
          tool: 'Read',
          input_digest: 'read-other-file',
          outcome: 'success' as const,
          error_class: null,
          duration_ms: 200,
        },
      },
      {
        line: 5,
        event: {
          kind: 'turn' as const,
          ts: '2026-06-20T10:05:00.000Z',
          session_id: 'sess-123',
          turn: 2,
        },
      },
      {
        line: 6,
        event: {
          kind: 'turn' as const,
          ts: '2026-06-20T10:06:00.000Z',
          session_id: 'sess-123',
          turn: 3,
        },
      },
      {
        line: 7,
        event: {
          kind: 'turn' as const,
          ts: '2026-06-20T10:07:00.000Z',
          session_id: 'sess-123',
          turn: 4,
        },
      },
    ]

    const episodes = segmentJournal(events)
    expect(episodes.length).toBe(1)
    expect(episodes[0]?.outcome).toBe('abandoned')
    expect(episodes[0]?.journal_line_range.end).toBe(2) // Abandoned at pivot point (the user event line)
  })

  it('should track repetitions and user corrections correctly', () => {
    const events = [
      {
        line: 1,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:01:00.000Z',
          session_id: 'sess-123',
          tool: 'Bash',
          input_digest: 'digest-1',
          outcome: 'failure' as const,
          error_class: 'TypeError',
          duration_ms: 1000,
          fingerprints: [
            {
              coarse: 'bash|TypeError',
              medium: 'bash|TypeError|src/bug.ts',
              fine: 'bash|TypeError|src/bug.ts|error',
            },
          ],
        },
      },
      {
        line: 2,
        event: {
          kind: 'permission' as const,
          ts: '2026-06-20T10:01:30.000Z',
          session_id: 'sess-123',
          decision: 'deny' as const,
          key: 'Edit:key',
        },
      },
      {
        line: 3,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:02:00.000Z',
          session_id: 'sess-123',
          tool: 'Bash',
          input_digest: 'digest-2',
          outcome: 'failure' as const,
          error_class: 'TypeError',
          duration_ms: 1000,
          fingerprints: [
            {
              coarse: 'bash|TypeError',
              medium: 'bash|TypeError|src/bug.ts',
              fine: 'bash|TypeError|src/bug.ts|error',
            },
          ],
        },
      },
      {
        line: 4,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:03:00.000Z',
          session_id: 'sess-123',
          tool: 'Edit',
          input_digest: 'digest-3',
          outcome: 'success' as const,
          error_class: null,
          duration_ms: 500,
          path: 'src/bug.ts',
        },
      },
      {
        line: 5,
        event: {
          kind: 'verify' as const,
          ts: '2026-06-20T10:04:00.000Z',
          session_id: 'sess-123',
          verdict: 'PASS' as const,
          fingerprints: [],
          command: 'bun test',
          exit_code: 0,
          stale: false,
        },
      },
    ]

    // Deny event sets hasPermissionDeny = true, which lowers score to 0.6
    const episodes = segmentJournal(events)
    expect(episodes.length).toBe(1)
    expect(episodes[0]?.outcome).toBe('resolved')
    expect(episodes[0]?.value_score).toBe(0.6)
  })

  it('should ignore tool failures that have no fingerprints', () => {
    const events = [
      {
        line: 1,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:01:00.000Z',
          session_id: 'sess-123',
          tool: 'Edit',
          input_digest: 'digest-edit',
          outcome: 'failure' as const,
          error_class: 'permission_denied',
          duration_ms: 100,
          path: 'src/secret.ts',
        },
      },
    ]

    const episodes = segmentJournal(events)
    expect(episodes.length).toBe(0)
  })

  it('should NOT resolve FIXING episodes if a Bash command succeeds but exits with code 1 without fingerprints', () => {
    const events = [
      {
        line: 1,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:01:00.000Z',
          session_id: 'sess-123',
          tool: 'Bash',
          input_digest: 'digest-1',
          outcome: 'failure' as const,
          error_class: 'TypeError',
          duration_ms: 1000,
          fingerprints: [
            {
              coarse: 'bash|TypeError',
              medium: 'bash|TypeError|src/bug.ts',
              fine: 'bash|TypeError|src/bug.ts|error',
            },
          ],
        },
      },
      {
        line: 2,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:02:00.000Z',
          session_id: 'sess-123',
          tool: 'Edit',
          input_digest: 'digest-2',
          outcome: 'success' as const,
          error_class: null,
          duration_ms: 500,
          path: 'src/bug.ts',
        },
      },
      {
        line: 3,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:03:00.000Z',
          session_id: 'sess-123',
          tool: 'Bash',
          input_digest: 'digest-3',
          outcome: 'success' as const,
          error_class: null,
          duration_ms: 500,
          exit_code: 1,
        },
      },
    ]

    const episodes = segmentJournal(events)
    expect(episodes.length).toBe(1)
    expect(episodes[0]?.outcome).toBe('abandoned')
  })

  it('should collect multi-edit candidates with ranked roles and discount scores', () => {
    const events = [
      {
        line: 1,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:01:00.000Z',
          session_id: 'sess-123',
          tool: 'Bash',
          input_digest: 'digest-1',
          outcome: 'failure' as const,
          error_class: 'TypeError',
          duration_ms: 1000,
          cmd: 'bun test',
          fingerprints: [
            {
              coarse: 'bash|TypeError',
              medium: 'bash|TypeError|src/buggy.ts',
              fine: 'bash|TypeError|src/buggy.ts|null pointer',
              tool: 'bash',
              error_class: 'TypeError',
              file: 'src/buggy.ts',
              expression: 'null pointer',
            },
          ],
        },
      },
      {
        line: 2,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:02:00.000Z',
          session_id: 'sess-123',
          tool: 'Edit',
          input_digest: 'digest-2',
          outcome: 'success' as const,
          path: 'src/buggy.ts',
          duration_ms: 500,
          error_class: null,
        },
      },
      {
        line: 3,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:03:00.000Z',
          session_id: 'sess-123',
          tool: 'Edit',
          input_digest: 'digest-3',
          outcome: 'success' as const,
          path: 'src/utils.ts', // same directory -> related
          duration_ms: 500,
          error_class: null,
        },
      },
      {
        line: 4,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:04:00.000Z',
          session_id: 'sess-123',
          tool: 'Write',
          input_digest: 'digest-4',
          outcome: 'success' as const,
          path: 'tests/buggy.test.ts', // different directory -> indirect
          duration_ms: 500,
          error_class: null,
        },
      },
      {
        line: 5,
        event: {
          kind: 'verify' as const,
          ts: '2026-06-20T10:05:00.000Z',
          session_id: 'sess-123',
          verdict: 'PASS' as const,
          fingerprints: [],
          command: 'bun test',
          exit_code: 0,
          stale: false,
        },
      },
    ]

    const episodes = segmentJournal(events)
    expect(episodes.length).toBe(1)
    const ep = episodes[0]
    expect(ep).toBeDefined()
    expect(ep?.outcome).toBe('resolved')

    // 3 candidates collected
    expect(ep?.fix_candidates.length).toBe(3)

    const buggyCand = ep?.fix_candidates.find((c) => c.path === 'src/buggy.ts')
    expect(buggyCand?.role).toBe('direct')

    const utilsCand = ep?.fix_candidates.find((c) => c.path === 'src/utils.ts')
    expect(utilsCand?.role).toBe('related')

    const testCand = ep?.fix_candidates.find((c) => c.path === 'tests/buggy.test.ts')
    expect(testCand?.role).toBe('indirect')

    // Attribution should be multi_with_direct
    expect(ep?.attribution.status).toBe('multi_with_direct')
    expect(ep?.attribution.primary).toBe('src/buggy.ts')
    expect(ep?.attribution.confidence).toBe(0.7)

    // Score should be baseline 1.0 * multiplier 0.85 = 0.85
    expect(ep?.value_score).toBe(0.85)
  })

  it('should preserve multiple distinct edits to the same file path and count as single_direct', () => {
    const events = [
      {
        line: 1,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:01:00.000Z',
          session_id: 'sess-123',
          tool: 'Bash',
          input_digest: 'digest-1',
          outcome: 'failure' as const,
          error_class: 'TypeError',
          duration_ms: 1000,
          cmd: 'bun test',
          fingerprints: [
            {
              coarse: 'bash|TypeError',
              medium: 'bash|TypeError|src/buggy.ts',
              fine: 'bash|TypeError|src/buggy.ts|null pointer',
              tool: 'bash',
              error_class: 'TypeError',
              file: 'src/buggy.ts',
              expression: 'null pointer',
            },
          ],
        },
      },
      {
        line: 2,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:02:00.000Z',
          session_id: 'sess-123',
          tool: 'Edit',
          input_digest: 'digest-edit-1',
          outcome: 'success' as const,
          path: 'src/buggy.ts',
          duration_ms: 500,
          error_class: null,
        },
      },
      {
        line: 3,
        event: {
          kind: 'verify' as const,
          ts: '2026-06-20T10:03:00.000Z',
          session_id: 'sess-123',
          verdict: 'FAIL' as const,
          fingerprints: [
            {
              coarse: 'bash|TypeError',
              medium: 'bash|TypeError|src/buggy.ts',
              fine: 'bash|TypeError|src/buggy.ts|null pointer',
              tool: 'bash',
              error_class: 'TypeError',
              file: 'src/buggy.ts',
              expression: 'null pointer',
            },
          ],
          command: 'bun test',
          exit_code: 1,
          stale: false,
        },
      },
      {
        line: 4,
        event: {
          kind: 'tool' as const,
          ts: '2026-06-20T10:04:00.000Z',
          session_id: 'sess-123',
          tool: 'Edit',
          input_digest: 'digest-edit-2',
          outcome: 'success' as const,
          path: 'src/buggy.ts',
          duration_ms: 500,
          error_class: null,
        },
      },
      {
        line: 5,
        event: {
          kind: 'verify' as const,
          ts: '2026-06-20T10:05:00.000Z',
          session_id: 'sess-123',
          verdict: 'PASS' as const,
          fingerprints: [],
          command: 'bun test',
          exit_code: 0,
          stale: false,
        },
      },
    ]

    const episodes = segmentJournal(events)
    expect(episodes.length).toBe(1)
    const ep = episodes[0]
    expect(ep).toBeDefined()
    expect(ep?.outcome).toBe('resolved')

    // Both edits are preserved
    expect(ep?.fix_candidates.length).toBe(2)
    expect(ep?.fix_candidates[0]?.path).toBe('src/buggy.ts')
    expect(ep?.fix_candidates[1]?.path).toBe('src/buggy.ts')

    // Status is multi_with_direct because there are multiple edit attempts
    expect(ep?.attribution.status).toBe('multi_with_direct')
    expect(ep?.attribution.primary).toBe('src/buggy.ts')
    expect(ep?.attribution.confidence).toBe(0.7)
    expect(ep?.value_score).toBe(0.85)
  })
})
