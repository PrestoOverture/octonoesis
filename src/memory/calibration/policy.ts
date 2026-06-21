import type { BucketStats } from './stats.ts'

export type Recommendation = 'confident' | 'review-recommended' | 'insufficient-data'

/**
 * Returns a safety recommendation based on aggregated statistics of a task bucket.
 * Low-confidence buckets or those with small sample sizes prompt for reviews.
 *
 * @param stats Aggregated statistics for the task bucket.
 * @returns The recommendation: 'confident' | 'review-recommended' | 'insufficient-data'.
 */
export function assessBucket(stats: BucketStats): Recommendation {
  const total = stats.total_attempts
  if (total < 3) {
    return 'insufficient-data'
  }
  if (total < 5) {
    return 'review-recommended'
  }
  const rate = stats.first_attempt_success / total
  if (rate >= 0.7) {
    return 'confident'
  }
  return 'review-recommended'
}
