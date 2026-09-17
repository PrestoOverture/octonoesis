import type { RuleFile } from './types.ts'

/**
 * Returns whether a rule status consumes one of the active-pool slots (active or candidate).
 *
 * @param status - The rule status to check
 * @returns True if the status is 'active' or 'candidate', false otherwise
 */
export function isPoolCapRelevantStatus(status: RuleFile['status']): boolean {
  return status === 'active' || status === 'candidate'
}

/**
 * Calculates the specificity of a rule based on its error signature.
 *
 * @param rule - The RuleFile object to check
 * @returns The specificity score (1 for coarse, 2 for medium, 3 for fine)
 */
export function getRuleSpecificity(rule: RuleFile): number {
  if (!rule.triggers.error_signatures || rule.triggers.error_signatures.length === 0) {
    return 1
  }
  const sig = rule.triggers.error_signatures[0]
  if (!sig) return 1

  const partsCount = sig.split('|').length
  if (partsCount >= 4) return 3 // fine
  if (partsCount === 3) return 2 // medium
  return 1 // coarse
}

/**
 * Enforces the active pool cap of 150 rules, retiring lowest-scoring rules if exceeded.
 *
 * @param rules - The full array of rules
 * @returns The array of rules with pool cap enforced
 *
 * Mutates overflowing active/candidate rules by setting their `status` to `'retired'`.
 */
export function enforcePoolCap(rules: RuleFile[]): RuleFile[] {
  const activeAndCandidates = rules.filter((r) => isPoolCapRelevantStatus(r.status))
  if (activeAndCandidates.length <= 150) {
    return rules
  }

  // Calculate scores for active/candidate rules
  const scoredRules = activeAndCandidates.map((rule) => {
    const specificity = getRuleSpecificity(rule)
    const createdTime = new Date(rule.created_at).getTime()
    const daysSinceCreation = Math.max(0, (Date.now() - createdTime) / (24 * 60 * 60 * 1000))
    const timeDecay = Math.exp(-0.01 * daysSinceCreation)
    const score = specificity * rule.confidence * timeDecay
    return { rule, score }
  })

  // Sort scored rules ascending by score (lowest score first)
  scoredRules.sort((a, b) => a.score - b.score)

  const overflowCount = activeAndCandidates.length - 150
  for (let i = 0; i < overflowCount; i++) {
    const entry = scoredRules[i]
    if (entry) {
      entry.rule.status = 'retired'
    }
  }

  return rules
}
