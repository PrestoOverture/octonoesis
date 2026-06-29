import type { Fingerprint } from '../fingerprint/extract.ts'
import type { RuleFile } from './types.ts'

export type MatchLevel = 'fine' | 'medium' | 'coarse'

export interface MatchResult {
  rule: RuleFile
  fingerprint: Fingerprint
  level: MatchLevel
}

/**
 * Searches active/candidate rules by error signature in priority order: fine -> medium -> coarse.
 * Returns up to 2 matches.
 * @param fingerprints The list of error fingerprints to match.
 * @param rules The pool of rules to search.
 * @returns An array of matched rule details.
 */
export function findMatchingRules(fingerprints: Fingerprint[], rules: RuleFile[]): MatchResult[] {
  const matchedRuleIds = new Set<string>()
  const results: MatchResult[] = []

  const eligibleRules = rules.filter(
    (rule) => rule.status === 'active' || rule.status === 'candidate',
  )

  const levels: MatchLevel[] = ['fine', 'medium', 'coarse']

  for (const level of levels) {
    for (const fingerprint of fingerprints) {
      for (const rule of eligibleRules) {
        if (matchedRuleIds.has(rule.id)) {
          continue
        }

        const signature =
          level === 'fine'
            ? fingerprint.fine
            : level === 'medium'
              ? fingerprint.medium
              : fingerprint.coarse

        if (rule.triggers.error_signatures.includes(signature)) {
          matchedRuleIds.add(rule.id)
          results.push({
            rule,
            fingerprint,
            level,
          })

          if (results.length === 2) {
            return results
          }
        }
      }
    }
  }

  return results
}

/**
 * Formats the matched rule's advice text using appropriate confidence framing.
 * @param match The matched rule outcome.
 * @returns The formatted advice markdown string.
 */
export function formatMatchAdvice(match: MatchResult): string {
  if (match.level === 'coarse') {
    return `[Low-confidence advice fallback]
*This repository has sometimes seen this class of error. Here is a general rule that might help:*

${match.rule.advice}`
  }

  return `*The following rule matched your current error signature:*

${match.rule.advice}`
}
