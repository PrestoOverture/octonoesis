import type { RuleFile } from './types.ts'

/** Maximum number of rules injected into the cache-stable system prompt at session start. */
export const SESSION_START_RULE_LIMIT = 10

const ELIGIBLE_STATUSES: ReadonlySet<RuleFile['status']> = new Set(['active', 'pinned'])

/**
 * Returns whether a rule's error signatures are all coarse (at most 2 `|`-separated parts).
 * A rule with zero error signatures is vacuously broad. A single medium (3-part) or fine
 * (4+-part) signature disqualifies the whole rule, even if other signatures are coarse.
 * @param rule The rule to test.
 * @returns Whether the rule is broad enough for session-start injection.
 */
function isBroadRule(rule: RuleFile): boolean {
  return rule.triggers.error_signatures.every((signature) => signature.split('|').length <= 2)
}

/**
 * Selects up to SESSION_START_RULE_LIMIT broad, repo-scoped, externally-validated rules for
 * session-start injection into the cache-stable system prompt segment.
 *
 * Pure and deterministic: eligibility is `scope === 'repo'`, status `'active'` or `'pinned'`,
 * and a broad trigger (see isBroadRule). Eligible rules are sorted by confidence descending,
 * then id ascending as a byte-stable tiebreak, so identical input pools always produce an
 * identically-ordered result and the compiled prompt segment stays byte-identical across calls.
 * @param rules The full rule pool already loaded for the query.
 * @returns The selected rules, ready to pass to formatSessionStartRules.
 */
export function selectSessionStartRules(rules: readonly RuleFile[]): RuleFile[] {
  return rules
    .filter(
      (rule) => rule.scope === 'repo' && ELIGIBLE_STATUSES.has(rule.status) && isBroadRule(rule),
    )
    .sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, SESSION_START_RULE_LIMIT)
}

/**
 * Formats selected session-start rules into a deterministic markdown block for the
 * cache-stable system prompt segment. Frames the rules honestly as guidance derived from
 * episodes observed in this repository's own history, not as absolute commands.
 * @param rules The rules to format, typically the output of selectSessionStartRules.
 * @returns A markdown block, or '' when rules is empty.
 */
export function formatSessionStartRules(rules: readonly RuleFile[]): string {
  if (rules.length === 0) return ''

  const entries = rules.map((rule) => `### ${rule.id}\n${rule.advice}`).join('\n\n')

  return [
    '## Repository Rules (Learned From Past Sessions)',
    "These are patterns distilled from episodes observed in this repository's own history. " +
      'They are guidance from what has worked or failed before, not absolute commands — use ' +
      'judgment for the task at hand.',
    '',
    entries,
  ].join('\n')
}
