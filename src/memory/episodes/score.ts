import type { Episode } from './types'

/**
 * Assigns value scores and exclusions to segmented episodes.
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
  } else if (!partial.fix) {
    value_score = 0.0
    is_excluded = true
    exclusion_reason = 'no_fix_recorded'
  } else {
    // Resolved and has a fix
    if (options?.hasPermissionDeny) {
      value_score = 0.6 // User correction
    } else if (options?.repetitionCount && options.repetitionCount > 1) {
      value_score = 0.4 // Repeated failures before resolve
    } else {
      value_score = 1.0 // Clean verification flip
    }
  }

  return {
    id,
    ...partial,
    value_score,
    is_excluded,
    exclusion_reason,
  }
}
