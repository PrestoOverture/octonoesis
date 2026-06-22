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
    'Observations',
    'Posterior Mean',
    '95% Credible Interval',
    'Recommendation',
  ]
  const rows = statsList.map((stats) => {
    const total = stats.total_attempts
    const meanPct = `${Math.round(stats.posterior_mean * 100)}%`
    const ciStr = `[${Math.round(stats.credible_interval[0] * 100)}% - ${Math.round(stats.credible_interval[1] * 100)}%]`
    const rec = assessBucket(stats)

    let recStr = rec as string
    if (rec === 'confident') {
      recStr = 'confident'
    } else if (rec === 'review-recommended') {
      recStr = '⚠ review recommended'
    } else if (rec === 'uncertain') {
      recStr = 'uncertain'
    }

    return [stats.bucket_key, total.toString(), meanPct, ciStr, recStr]
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
