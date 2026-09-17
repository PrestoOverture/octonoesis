import { createHash } from 'node:crypto'
import type { RuleFile } from './types.ts'

const COLLISION_HASH_LENGTH = 8

/**
 * Keeps the model slug when unused and adds a stable signature hash only on collision with existing rule IDs.
 *
 * @param rule - The rule to potentially disambiguate
 * @param signature - The failure or context signature used to derive hash suffixes
 * @param existingRules - List of already registered rules to check for ID collisions
 * @returns A rule with either the original ID or a collision-disambiguated ID
 */
export function disambiguateRuleId(
  rule: RuleFile,
  signature: string,
  existingRules: RuleFile[],
): RuleFile {
  if (!existingRules.some((existing) => existing.id === rule.id)) return rule

  const hash = createHash('sha256').update(signature).digest('hex')
  let hashLength = COLLISION_HASH_LENGTH
  let id = `${rule.id}-${hash.slice(0, hashLength)}`
  while (existingRules.some((existing) => existing.id === id) && hashLength < hash.length) {
    hashLength = Math.min(hash.length, hashLength + 4)
    id = `${rule.id}-${hash.slice(0, hashLength)}`
  }

  return { ...rule, id }
}
