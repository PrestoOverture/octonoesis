import type { Observation } from './model'
import { families } from './tasks'

export const CALIBRATION_RULE = {
  max_error_fraction: 0.05,
  min_failure_rate: 0.2,
  max_failure_rate: 0.7,
  min_pooled: 25,
  min_per_family: 5,
  min_informative_families: 3,
  min_attempt_coverage: 0.8,
  min_signal_families: 3,
  min_recurring_sessions: 2,
} as const

/** Feasibility screen, not a hypothesis test of five noisy family proportions. */
export function calibrationGate(
  rows: Observation[],
  rule: { [K in keyof typeof CALIBRATION_RULE]: number } = CALIBRATION_RULE,
) {
  const valid = rows.filter((r) => r.status !== 'ERROR')
  const failures = valid.filter((r) => r.status === 'FAIL').length
  const n = valid.length
  const rate = n ? failures / n : null
  const z = 1.959963984540054
  const den = 1 + (z * z) / n
  const mid = n ? ((rate as number) + (z * z) / (2 * n)) / den : 0
  const half = n
    ? (z * Math.sqrt(((rate as number) * (1 - (rate as number))) / n + (z * z) / (4 * n * n))) / den
    : 0
  const byFamily = Object.fromEntries(
    families.map((family) => {
      const group = valid.filter((r) => r.job.task.family === family)
      const failed = group.filter((r) => r.status === 'FAIL').length
      return [
        family,
        { valid: group.length, failures: failed, informative: failed > 0 && failed < group.length },
      ]
    }),
  )
  const reasons: string[] = []
  if (rows.length - n > Math.floor(rows.length * rule.max_error_fraction))
    reasons.push('Operational errors exceed the fixed 5% tolerance.')
  if (n < rule.min_pooled) reasons.push('Too few valid pooled sessions.')
  if (
    failures < Math.ceil(n * rule.min_failure_rate) ||
    failures > Math.floor(n * rule.max_failure_rate)
  )
    reasons.push('Pooled first-tested-repair failure rate outside registered band.')
  for (const [family, group] of Object.entries(byFamily)) {
    if (group.valid < rule.min_per_family) reasons.push(`${family}: too few valid sessions.`)
    if (group.valid && group.failures === group.valid)
      reasons.push(`${family}: all valid sessions failed.`)
  }
  if (Object.values(byFamily).filter((g) => g.informative).length < rule.min_informative_families)
    reasons.push('Fewer than three informative families; at most two may be saturated.')
  const signalFamilies = new Set(
    valid
      .filter(
        (r) =>
          r.observed_repair_failure && r.observed_repair_resolution && r.hidden_status === 'PASS',
      )
      .map((r) => r.job.task.family),
  )
  if (signalFamilies.size < rule.min_signal_families)
    reasons.push(
      'Fewer than three families with an observed post-repair failure followed by a hidden-correct final submission.',
    )
  const attempted = valid.filter((r) => r.first_attempt?.source_hash).length
  if (attempted < Math.ceil(n * rule.min_attempt_coverage))
    reasons.push('Insufficient tested-repair snapshot coverage.')
  return {
    eligible: reasons.length === 0,
    signal_families: [...signalFamilies],
    reasons,
    rule,
    valid_sessions: n,
    failures,
    failure_rate: rate,
    ci95: n ? [Math.max(0, mid - half), Math.min(1, mid + half)] : null,
    attempt_coverage: n ? attempted / n : null,
    families: byFamily,
  }
}
