import { describe, expect, it } from 'bun:test'
import { scoreEpisode } from '../../../../src/memory/episodes/score'
import type { Episode } from '../../../../src/memory/episodes/types'

describe('Episode Value Scoring', () => {
  const baseEpisode: Omit<Episode, 'id' | 'value_score' | 'is_excluded' | 'exclusion_reason'> = {
    session_id: 'sess-123',
    timestamp: '2026-06-20T10:00:00Z',
    task_digest: 'digest-123',
    failure: {
      tool: 'Bash',
      cmd: 'bun test',
      error_class: 'TypeError',
      signature: 'bash|TypeError|src/buggy.ts',
    },
    fix: {
      tool: 'Edit',
      path: 'src/buggy.ts',
      summary: 'added check',
    },
    outcome: 'resolved',
    journal_line_range: { start: 1, end: 10 },
  }

  it('should score 1.0 for clean verification flips', () => {
    const ep = scoreEpisode(baseEpisode, 1)
    expect(ep.id).toBe('ep_0001')
    expect(ep.value_score).toBe(1.0)
    expect(ep.is_excluded).toBe(false)
    expect(ep.exclusion_reason).toBe(null)
  })

  it('should score 0.6 if permission deny happened', () => {
    const ep = scoreEpisode(baseEpisode, 2, { hasPermissionDeny: true })
    expect(ep.id).toBe('ep_0002')
    expect(ep.value_score).toBe(0.6)
    expect(ep.is_excluded).toBe(false)
  })

  it('should score 0.4 if multiple failures repeated before resolution', () => {
    const ep = scoreEpisode(baseEpisode, 3, { repetitionCount: 3 })
    expect(ep.id).toBe('ep_0003')
    expect(ep.value_score).toBe(0.4)
    expect(ep.is_excluded).toBe(false)
  })

  it('should exclude abandoned episodes', () => {
    const abandonedEp = { ...baseEpisode, outcome: 'abandoned' as const }
    const ep = scoreEpisode(abandonedEp, 4)
    expect(ep.value_score).toBe(0.0)
    expect(ep.is_excluded).toBe(true)
    expect(ep.exclusion_reason).toBe('abandoned')
  })

  it('should exclude episodes without fix edits', () => {
    const noFixEp = { ...baseEpisode, fix: undefined }
    const ep = scoreEpisode(noFixEp, 5)
    expect(ep.value_score).toBe(0.0)
    expect(ep.is_excluded).toBe(true)
    expect(ep.exclusion_reason).toBe('no_fix_recorded')
  })
})
