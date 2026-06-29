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
  alpha: number
  beta: number
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
 * Calculates rule confidence based on Beta distribution posterior mean.
 * @param alpha The alpha parameter.
 * @param beta The beta parameter.
 * @returns The calculated confidence score.
 */
export function calculateConfidence(alpha: number, beta: number): number {
  const sum = alpha + beta
  return sum > 0 ? Number((alpha / sum).toFixed(4)) : 0.5
}
