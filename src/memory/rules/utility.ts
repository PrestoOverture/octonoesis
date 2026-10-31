import { createHash } from 'node:crypto'
import { credibleInterval } from '../calibration/beta'
import type { RuleFile } from './types'

export const UTILITY_MIN_SESSIONS = 8
export const UTILITY_CREDIBLE_LEVEL = 0.95
export const UTILITY_BREAK_EVEN = 0.5

/** Independent feature switch; thresholds are fixed, not fitted to evaluation outcomes. */
export function ruleUtilityEnabled(): boolean {
  return !['1', 'true', 'yes', 'on'].includes(
    process.env.OCTONOESIS_DISABLE_RULE_UTILITY?.trim().toLowerCase() ?? '',
  )
}

/** At most one verified outcome per rule/session; legacy counters are not session evidence. */
export function observeUtility(rule: RuleFile, hit: boolean, sessionId?: string): void {
  if (!sessionId || !ruleUtilityEnabled()) return
  const session = createHash('sha256').update(sessionId).digest('hex')
  rule.utility ??= { hits: 0, misses: 0, sessions: [] }
  const utility = rule.utility
  if (utility.sessions.includes(session)) return
  utility.sessions.push(session)
  if (hit) utility.hits++
  else utility.misses++
}

/** Beta(2,2), eight independent sessions, and symmetric break-even decisions. */
export function applyUtilityLifecycle(rule: RuleFile): RuleFile {
  const utility = rule.utility
  if (!ruleUtilityEnabled() || !utility || utility.sessions.length < UTILITY_MIN_SESSIONS)
    return rule
  if (rule.status !== 'active' && rule.status !== 'candidate') return rule
  const posterior = { alpha: 2 + utility.hits, beta: 2 + utility.misses }
  const [lower, upper] = credibleInterval(posterior, UTILITY_CREDIBLE_LEVEL)
  if (upper < UTILITY_BREAK_EVEN) {
    rule.status = 'retired'
    rule.retirement_reason =
      `poor verified-recovery utility: ${utility.hits} hits, ${utility.misses} misses across ` +
      `${utility.sessions.length} sessions; Beta(2,2) 95% upper bound ${upper.toFixed(4)} < 0.5`
  } else if (lower > UTILITY_BREAK_EVEN) {
    rule.status = 'active'
  } else if (posterior.alpha / (posterior.alpha + posterior.beta) < UTILITY_BREAK_EVEN) {
    rule.status = 'candidate'
  }
  return rule
}
