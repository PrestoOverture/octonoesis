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
        total_attempts: 5,
        first_attempt_success: 4,
        user_modifications: 0,
        user_reverts: 0,
        avg_attempts_to_resolve: 1.5,
      },
      {
        bucket_key: 'tsc|SyntaxError',
        model_id: 'gpt-5-nano',
        total_attempts: 2,
        first_attempt_success: 1,
        user_modifications: 1,
        user_reverts: 0,
        avg_attempts_to_resolve: 2.0,
      },
    ]

    const table = formatStatsTable(stats)
    const lines = table.split('\n')

    expect(lines.length).toBe(4) // header, divider, row1, row2
    expect(lines[0]).toContain('Bucket')
    expect(lines[0]).toContain('Attempts')
    expect(lines[0]).toContain('First-Try Success')
    expect(lines[0]).toContain('Avg Resolve Attempts')
    expect(lines[0]).toContain('Recommendation')

    expect(lines[2]).toContain('bun-test|TypeError')
    expect(lines[2]).toContain('5')
    expect(lines[2]).toContain('4 (80%)')
    expect(lines[2]).toContain('1.5')
    expect(lines[2]).toContain('confident')

    expect(lines[3]).toContain('tsc|SyntaxError')
    expect(lines[3]).toContain('2')
    expect(lines[3]).toContain('1 (50%)')
    expect(lines[3]).toContain('2.0')
    expect(lines[3]).toContain('insufficient data')
  })
})
