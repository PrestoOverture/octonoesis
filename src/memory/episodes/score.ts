import type { Episode } from './types'

const TRANSIENT_ERROR_CLASSES = ['CommandNotFound', 'ENOENT', 'ETIMEDOUT']

/**
 * Checks if an error class is classified as a transient error.
 * @param errorClass The error class string.
 * @returns True if transient, false otherwise.
 */

function isTransientError(errorClass: string): boolean {
  return TRANSIENT_ERROR_CLASSES.includes(errorClass)
}

/**
 * Assigns value scores and exclusions to segmented episodes.
 * @param partial The partial episode details lacking ID, score, and exclusion info.
 * @param idIndex The index of the episode to format the ID (e.g. ep_0001).
 * @param options Optional context details like user permission denials or repetition counts.
 * @returns The fully scored Episode object.
 */
export function scoreEpisode(
  partial: Omit<Episode, 'id' | 'value_score' | 'is_excluded' | 'exclusion_reason'>,
  idIndex: number,
  options?: {
    hasPermissionDeny?: boolean
    repetitionCount?: number
  },
): Episode {
  const id = `ep_${String(idIndex).padStart(4, '0')}`
  let value_score = 0.0
  let is_excluded = false
  let exclusion_reason: string | null = null

  if (partial.outcome === 'abandoned') {
    value_score = 0.0
    is_excluded = true
    exclusion_reason = 'abandoned'
  } else if (partial.attribution.status === 'unattributable') {
    value_score = 0.0
    is_excluded = true
    exclusion_reason = 'unattributable'
  } else if (isTransientError(partial.failure.error_class)) {
    value_score = 0.0
    is_excluded = true
    exclusion_reason = 'transient'
  } else {
    // Resolved and has valid candidates
    let baseline = 1.0
    if (options?.hasPermissionDeny) {
      baseline = 0.6 // User correction
    } else if (options?.repetitionCount && options.repetitionCount > 1) {
      baseline = 0.4 // Repeated failures before resolve
    }

    let multiplier = 1.0
    if (partial.attribution.status === 'multi_with_direct') {
      multiplier = 0.85
    } else if (partial.attribution.status === 'indirect_only') {
      multiplier = 0.5
    }

    value_score = Number((baseline * multiplier).toFixed(4))
  }

  return {
    id,
    ...partial,
    value_score,
    is_excluded,
    exclusion_reason,
  }
}
