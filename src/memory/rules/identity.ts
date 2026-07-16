import { createHash } from 'node:crypto'
import type { RuleFile } from './types.ts'

const COLLISION_HASH_LENGTH = 8

/** Keeps the model slug when unused and adds a stable signature hash only on collision. */
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
