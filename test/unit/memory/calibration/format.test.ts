import { describe, expect, it } from 'bun:test'
import { formatStatsTable } from '../../../../src/memory/calibration/format.ts'
import type { BucketStats } from '../../../../src/memory/calibration/stats.ts'

describe('Stats Table Formatter', () => {
  it('should return empty message when list is empty', () => {
    const table = formatStatsTable([])
    expect(table).toBe('No calibration statistics accumulated yet.')
  })

  it('should format stats list into a padded ASCII table', () => {
    const stats: BucketStats[] = [
      {
        bucket_key: 'bun-test|TypeError',
        model_id: 'gpt-5-nano',
        alpha: 32,
        beta: 7,
        posterior_mean: 32 / 39,
        credible_interval: [0.68, 0.92],
        total_attempts: 35,
        first_attempt_success: 30,
        user_modifications: 0,
        user_reverts: 0,
      },
      {
        bucket_key: 'tsc|SyntaxError',
        model_id: 'gpt-5-nano',
        alpha: 3,
        beta: 3,
        posterior_mean: 0.5,
        credible_interval: [0.15, 0.85],
        total_attempts: 2,
        first_attempt_success: 1,
        user_modifications: 1,
        user_reverts: 0,
      },
    ]

    const table = formatStatsTable(stats)
    const lines = table.split('\n')

    expect(lines.length).toBe(4) // header, divider, row1, row2
    expect(lines[0]).toContain('Bucket')
    expect(lines[0]).toContain('Observations')
    expect(lines[0]).toContain('Posterior Mean')
    expect(lines[0]).toContain('95% Credible Interval')
    expect(lines[0]).toContain('Recommendation')

    expect(lines[2]).toContain('bun-test|TypeError')
    expect(lines[2]).toContain('35')
    expect(lines[2]).toContain('82%')
    expect(lines[2]).toContain('[68% - 92%]')
    expect(lines[2]).toContain('confident')

    expect(lines[3]).toContain('tsc|SyntaxError')
    expect(lines[3]).toContain('2')
    expect(lines[3]).toContain('50%')
    expect(lines[3]).toContain('[15% - 85%]')
    expect(lines[3]).toContain('uncertain')
  })
})
