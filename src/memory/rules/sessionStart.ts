import { scrub } from '../fingerprint/scrub'
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

export const SESSION_START_INSIGHT_LIMIT = 2
export const INSIGHT_MIN_SCORE = 0.2
export const INSIGHT_MAX_CHARS = 400
export const TASK_EXCERPT_MAX_CHARS = 6000
export const INSIGHT_RETRIEVAL_ALGORITHM = 'tfidf-cosine-v1'

export interface InsightMatch {
  id: string
  insight: string
  score: number
}

export function insightRetrievalEnabled(): boolean {
  return !['1', 'true', 'yes', 'on'].includes(
    process.env.OCTONOESIS_DISABLE_INSIGHT_RETRIEVAL?.trim().toLowerCase() ?? '',
  )
}

// Fixed stop list; scrubber placeholders are not semantic evidence of task similarity.
const STOP_WORDS = new Set(
  'a an and are as at be by for from in is it of on or that the this to with redacted timestamp time date line col duration address'.split(
    ' ',
  ),
)
function terms(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const term of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (term.length < 2 || STOP_WORDS.has(term)) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  return counts
}

/** Keyless TF-IDF cosine over scrubbed task excerpts; no advice text or error-trigger expansion. */
export function selectSessionStartInsights(
  rules: readonly RuleFile[],
  task: string,
  repoRoot: string,
): InsightMatch[] {
  if (!insightRetrievalEnabled()) return []
  const query = terms(scrub(task, repoRoot).slice(0, TASK_EXCERPT_MAX_CHARS))
  if (!query.size) return []
  const candidates = rules
    .filter(
      (rule) =>
        rule.scope === 'repo' &&
        ['candidate', 'active', 'pinned'].includes(rule.status) &&
        rule.insight?.trim() &&
        rule.task_excerpt?.trim(),
    )
    .map((rule) => ({
      rule,
      counts: terms(scrub(rule.task_excerpt ?? '', repoRoot).slice(0, TASK_EXCERPT_MAX_CHARS)),
    }))
  const frequency = new Map<string, number>()
  for (const { counts } of candidates) {
    for (const term of counts.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  }
  const idf = (term: string) =>
    1 + Math.log((1 + candidates.length) / (1 + (frequency.get(term) ?? 0)))
  const vector = (counts: Map<string, number>) =>
    new Map([...counts].map(([term, count]) => [term, (1 + Math.log(count)) * idf(term)]))
  const norm = (values: Map<string, number>) =>
    Math.sqrt([...values.values()].reduce((sum, n) => sum + n * n, 0))
  const queryVector = vector(query)
  const queryNorm = norm(queryVector)
  return candidates
    .map(({ rule, counts }) => {
      const document = vector(counts)
      const dot = [...queryVector].reduce(
        (sum, [term, weight]) => sum + weight * (document.get(term) ?? 0),
        0,
      )
      const denominator = queryNorm * norm(document)
      return {
        id: rule.id,
        insight: scrub(rule.insight ?? '', repoRoot).slice(0, INSIGHT_MAX_CHARS),
        score: denominator ? dot / denominator : 0,
      }
    })
    .filter((match) => match.score >= INSIGHT_MIN_SCORE)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, SESSION_START_INSIGHT_LIMIT)
}

export function formatSessionStartInsights(matches: readonly InsightMatch[]): string {
  if (!matches.length) return ''
  return [
    '## Optional Insights From Past Sessions',
    'These are optional heuristics, not instructions. They never override the current task contract. Use only when relevant; preserve required behavior and validation.',
    ...matches.map((match) => `### ${match.id}\n${match.insight}`),
  ].join('\n\n')
}
