import type { RuleFile } from './types.ts'

/**
 * Calculates the specificity of a rule based on its error signature.
 * 3 elements (coarse) = 1, 4 elements (medium) = 2, 5+ elements (fine) = 3.
 * Wait, let's count pipe separators:
 * "bun-test|TypeError" has 1 pipe (2 parts) -> coarse -> 1
 * "bun-test|TypeError|src/buggy.ts" has 2 pipes (3 parts) -> medium -> 2
 * "bun-test|TypeError|src/buggy.ts|evaluating 'user.name'" has 3 pipes (4 parts) -> fine -> 3
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
 * Enforces the active pool cap of 150 rules.
 * If active rules exceed 150, the lowest scored rules are evicted to 'retired' status.
 */
export function enforcePoolCap(rules: RuleFile[]): RuleFile[] {
  const activeAndCandidates = rules.filter((r) => r.status === 'active' || r.status === 'candidate')
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
