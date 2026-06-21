import { assessBucket } from './policy.ts'
import type { BucketStats } from './stats.ts'

/**
 * Formats aggregated bucket statistics into a clean, alignment-padded ASCII table.
 *
 * @param statsList List of aggregated BucketStats.
 * @returns The formatted string table.
 */
export function formatStatsTable(statsList: BucketStats[]): string {
  if (statsList.length === 0) {
    return 'No calibration statistics accumulated yet.'
  }

  const headers = [
    'Bucket',
    'Attempts',
    'First-Try Success',
    'Avg Resolve Attempts',
    'Recommendation',
  ]
  const rows = statsList.map((stats) => {
    const total = stats.total_attempts
    const successRate =
      total > 0
        ? `${stats.first_attempt_success} (${Math.round((stats.first_attempt_success / total) * 100)}%)`
        : '0 (0%)'
    const avgAttempts = stats.avg_attempts_to_resolve.toFixed(1)
    const rec = assessBucket(stats)

    let recStr = rec as string
    if (rec === 'confident') {
      recStr = 'confident'
    } else if (rec === 'review-recommended') {
      recStr = '⚠ review recommended'
    } else if (rec === 'insufficient-data') {
      recStr = 'insufficient data'
    }

    return [stats.bucket_key, total.toString(), successRate, avgAttempts, recStr]
  })

  // Calculate width of each column
  const colWidths = headers.map((header, idx) => {
    return Math.max(header.length, ...rows.map((row) => row[idx]?.length || 0))
  })

  const formatRow = (cols: string[]) => {
    return cols.map((col, idx) => col.padEnd(colWidths[idx] || 0)).join(' | ')
  }

  const divider = colWidths.map((w) => '-'.repeat(w)).join('-+-')

  const lines = [formatRow(headers), divider, ...rows.map(formatRow)]

  return lines.join('\n')
}
