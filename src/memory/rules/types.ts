export type RuleStatus =
  | 'candidate'
  | 'active'
  | 'retired'
  | 'dormant'
  | 'pinned'
  | 'banned'
  | 'superseded'

export interface RuleFile {
  id: string // rule-<slug>
  triggers: {
    tools: string[]
    command_prefix: string[]
    error_signatures: string[]
  }
  scope: 'repo' | 'global'
  confidence: number
  evidence: string[] // array of episode IDs
  hits: number
  misses: number
  challenged_by: string[]
  anchor: {
    file: string
  }
  status: RuleStatus
  user_confirmed: boolean
  extractor_version: string
  model_id: string
  prompt_hash: string
  created_at: string
  last_matched_at: string | null
  last_rebuilt_at: string | null
  advice: string // Markdown description
}

/**
 * Calculates rule confidence based on hit/miss rates and evidence counts.
 * Formula: confidence = (hits + 0.5 * evidenceCount + 1) / (hits + misses + 0.5 * evidenceCount + 2)
 */
export function calculateConfidence(hits: number, misses: number, evidenceCount: number): number {
  const numerator = hits + 0.5 * evidenceCount + 1
  const denominator = hits + misses + 0.5 * evidenceCount + 2
  return Number((numerator / denominator).toFixed(4))
}
