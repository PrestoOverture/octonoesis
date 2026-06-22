import type { BetaParams } from './beta.ts'
import { intervalWidth, posteriorMean } from './beta.ts'

export type Recommendation = 'confident' | 'review-recommended' | 'uncertain'

/**
 * Returns a safety recommendation based on aggregated statistics of a task bucket.
 * Uses 95% credible interval and posterior mean to classify.
 *
 * @param params Beta parameters (alpha, beta).
 * @returns The recommendation: 'confident' | 'review-recommended' | 'uncertain'.
 */
export function assessBucket(params: BetaParams): Recommendation {
  const mean = posteriorMean(params)
  const width = intervalWidth(params, 0.95)

  if (width >= 0.5) {
    return 'uncertain'
  }
  if (mean >= 0.6) {
    return 'confident'
  }
  return 'review-recommended'
}
