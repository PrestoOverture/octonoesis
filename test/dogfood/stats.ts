import { calibrationGate } from './calibration'
import type { Arm, Observation, Plan } from './model'

function binomial(n: number, p: number): number[] {
  if (p === 0) return Array.from({ length: n + 1 }, (_, i) => Number(i === 0))
  if (p === 1) return Array.from({ length: n + 1 }, (_, i) => Number(i === n))
  const logs = [n * Math.log1p(-p)]
  for (let k = 1; k <= n; k++)
    logs.push(
      (logs[k - 1] as number) + Math.log(n - k + 1) - Math.log(k) + Math.log(p) - Math.log1p(-p),
    )
  return logs.map(Math.exp)
}

/** Two-sided exact McNemar (conditional binomial), including all-zero discordance. */
export function mcnemar(onOnly: number, offOnly: number): number {
  const n = onOnly + offOnly
  const distribution = binomial(n, 0.5)
  return Math.min(
    1,
    2 * distribution.slice(0, Math.min(onOnly, offOnly) + 1).reduce((a, b) => a + b, 0),
  )
}

/** Exact multinomial planning power under specified discordance and paired risk difference. */
export function planningPower(n: number, delta = 0.2, discordance = 0.5): number {
  return binomial(n, discordance).reduce(
    (power, weight, d) =>
      power +
      weight *
        binomial(d, (1 + delta / discordance) / 2).reduce(
          (sum, prob, b) => sum + (mcnemar(b, d - b) < 0.05 ? prob : 0),
          0,
        ),
    0,
  )
}

function wilson(successes: number, n: number): [number, number] {
  // 97.5% marginal intervals; Bonferroni yields >=95% asymptotic paired coverage.
  const z = 2.241402727604947
  const z2 = z * z
  const p = successes / n
  const den = 1 + z2 / n
  const mid = (p + z2 / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den
  return [Math.max(0, mid - half), Math.min(1, mid + half)]
}

export function pairedStats(rows: Observation[]) {
  const pairs = new Map<string, Partial<Record<Arm, Observation>>>()
  for (const row of rows) {
    if (row.job.arm === 'train') continue
    const pair = pairs.get(row.job.task.id) ?? {}
    if (pair[row.job.arm]) throw new Error('Duplicate arm observation')
    pair[row.job.arm] = row
    pairs.set(row.job.task.id, pair)
  }
  let n = 0
  let on = 0
  let off = 0
  let onOnly = 0
  let offOnly = 0
  for (const pair of pairs.values()) {
    if (!pair['rules-on'] || !pair['rules-off']) continue
    n++
    const a = pair['rules-on'].status === 'PASS'
    const b = pair['rules-off'].status === 'PASS'
    on += Number(a)
    off += Number(b)
    onOnly += Number(a && !b)
    offOnly += Number(b && !a)
  }
  let ci: [number, number] | null = null
  if (n) {
    const a = wilson(onOnly, n)
    const b = wilson(offOnly, n)
    ci = [a[0] - b[1], a[1] - b[0]]
  }
  return {
    pairs: n,
    on_successes: on,
    off_successes: off,
    on_only: onOnly,
    off_only: offOnly,
    risk_difference: n ? (on - off) / n : null,
    ci95: ci,
    p_value: n ? mcnemar(onOnly, offOnly) : null,
    method: 'two-sided exact McNemar; conservative Bonferroni-Wilson paired risk-difference CI',
  }
}

/** Fixed operational eligibility; ERROR remains an unsuccessful primary outcome. */
export function errorTolerance(plan: Plan, rows: Observation[]) {
  const evaluation = rows.filter((r) => r.job.arm !== 'train')
  const affected = new Set(evaluation.filter((r) => r.status === 'ERROR').map((r) => r.job.task.id))
  const on = evaluation.filter((r) => r.job.arm === 'rules-on' && r.status === 'ERROR').length
  const off = evaluation.filter((r) => r.job.arm === 'rules-off' && r.status === 'ERROR').length
  const training = rows.filter((r) => r.job.arm === 'train' && r.status === 'ERROR').length
  const maxPairs = Math.floor(plan.sample_size.pairs * plan.error_tolerance.max_pair_fraction)
  const maxTraining = Math.floor(
    plan.sample_size.training * plan.error_tolerance.max_training_fraction,
  )
  return {
    affected_pairs: affected.size,
    max_affected_pairs: maxPairs,
    rules_on_errors: on,
    rules_off_errors: off,
    arm_count_difference: Math.abs(on - off),
    max_arm_count_difference: plan.error_tolerance.max_arm_count_difference,
    training_errors: training,
    max_training_errors: maxTraining,
    eligible:
      affected.size <= maxPairs &&
      Math.abs(on - off) <= plan.error_tolerance.max_arm_count_difference &&
      training <= maxTraining,
  }
}

export function report(plan: Plan, rows: Observation[]) {
  for (const row of rows) {
    const expected = plan.jobs.find((job) => job.id === row.job.id)
    if (!expected || JSON.stringify(expected) !== JSON.stringify(row.job))
      throw new Error('Observation does not match preregistered arm/task')
  }
  const primary = pairedStats(rows)
  const errorPairs = new Set(
    rows.filter((r) => r.job.arm !== 'train' && r.status === 'ERROR').map((r) => r.job.task.id),
  )
  const sensitivity = pairedStats(
    rows.filter((r) => r.job.arm === 'train' || !errorPairs.has(r.job.task.id)),
  )
  const tolerance = errorTolerance(plan, rows)
  const training = rows.filter((r) => r.job.arm === 'train')
  const reasons: string[] = []
  if (plan.mode === 'dry-run')
    reasons.push('Scripted mock provider: pipeline demonstration, not model efficacy evidence.')
  if (rows.length !== plan.jobs.length || primary.pairs !== plan.sample_size.pairs)
    reasons.push('Fixed sample incomplete.')
  if (!tolerance.eligible)
    reasons.push('Operational errors exceed preregistered pair, arm-balance or training tolerance.')
  const calibration = Object.fromEntries(
    [...new Set(plan.tasks.map((t) => t.family))].map((family) => {
      const group = training.filter((r) => r.job.task.family === family)
      const valid = group.filter((r) => r.status !== 'ERROR')
      const failures = valid.filter((r) => r.status === 'FAIL').length
      const rate = valid.length ? failures / valid.length : null
      const sessions = new Map<string, Set<string>>()
      for (const row of group)
        for (const fp of row.fingerprints) {
          const ids = sessions.get(fp) ?? new Set<string>()
          ids.add(row.job.id)
          sessions.set(fp, ids)
        }
      const recurring = [...sessions]
        .filter(([, ids]) => ids.size >= plan.calibration.min_recurring_sessions)
        .map(([fp]) => fp)
      if (!recurring.length)
        reasons.push(`${family}: no observed recurring production fingerprint class.`)
      return [
        family,
        {
          sessions: group.length,
          valid_sessions: valid.length,
          errors: group.length - valid.length,
          failures,
          failure_rate: rate,
          recurring_fingerprints: recurring,
        },
      ]
    }),
  )
  const gate = calibrationGate(training, plan.calibration)
  reasons.push(...gate.reasons)
  const evaluation = rows.filter((r) => r.job.arm !== 'train')
  if (!evaluation.some((r) => r.job.arm === 'rules-on' && r.rules_before > 0))
    reasons.push('No trained eligible rules available for treatment.')
  const mean = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  const arms = Object.fromEntries(
    (['rules-on', 'rules-off'] as const).map((arm) => {
      const group = evaluation.filter((r) => r.job.arm === arm)
      const known = new Set(training.flatMap((r) => r.fingerprints))
      const repeats = group.filter((r) => r.fingerprints.some((fp) => known.has(fp))).length
      const hits = group.reduce((sum, r) => sum + r.hits, 0)
      const misses = group.reduce((sum, r) => sum + r.misses, 0)
      return [
        arm,
        {
          sessions: group.length,
          first_attempt_success: group.length
            ? group.filter((r) => r.status === 'PASS').length / group.length
            : null,
          repeat_failure_rate: group.length ? repeats / group.length : null,
          repeat_failure_sessions: repeats,
          mean_turns: mean(group.flatMap((r) => (r.output ? [r.output.turns] : []))),
          mean_tokens: mean(
            group.flatMap((r) =>
              r.output ? [r.output.usage.input_tokens + r.output.usage.output_tokens] : [],
            ),
          ),
          hits,
          misses,
          rule_hit_rate: hits + misses ? hits / (hits + misses) : null,
          errors: group.filter((r) => r.status === 'ERROR').length,
        },
      ]
    }),
  )
  const significant = primary.p_value !== null && primary.p_value < 0.05
  if (
    significant &&
    (sensitivity.p_value === null ||
      sensitivity.p_value >= 0.05 ||
      Math.sign(sensitivity.risk_difference ?? 0) !== Math.sign(primary.risk_difference ?? 0))
  )
    reasons.push(
      'Dropping operational-error pairs does not confirm the primary direction and significance.',
    )
  const verdict =
    reasons.length || !significant
      ? 'inconclusive'
      : (primary.risk_difference ?? 0) > 0
        ? 'helps'
        : 'harms'
  return {
    schema_version: 1,
    mode: plan.mode,
    verdict,
    reasons,
    primary,
    sensitivity,
    error_tolerance: tolerance,
    arms,
    calibration,
    calibration_gate: gate,
    planned_jobs: plan.jobs.length,
    completed_jobs: rows.length,
    preregistration: plan,
    limitations: [
      'First attempt is the first tested changed-source state, independently replayed against original public and hidden checks; final hidden success is a regression guard. Baseline unchanged-source tests do not count.',
      `Conditional on one trained ledger, ${new Set(plan.tasks.map((task) => task.family)).size} synthetic task families and a fixed provider/model. No R1 parameter search or R2 distiller comparison is performed.`,
      'Rule hit rate describes recovery on the next non-stale same-command verification, not causal benefit; repeat failures use observed coarse fingerprints from previously trained sessions, not hidden oracle labels.',
    ],
  }
}

export function markdown(result: ReturnType<typeof report>): string {
  const p = result.primary
  return `# Dogfood / RSC measurement\n\nVerdict: **${result.verdict}** (${result.mode})\n\n${result.reasons.map((r) => `- ${r}`).join('\n')}\n\nPaired first-tested-repair success lift (rules-on minus rules-off): ${p.risk_difference === null ? 'unavailable' : `${(100 * p.risk_difference).toFixed(1)} percentage points`}.\n95% CI: ${p.ci95 ? `[${p.ci95.map((v) => (100 * v).toFixed(1)).join(', ')}] percentage points` : 'unavailable'}; exact two-sided p = ${p.p_value ?? 'unavailable'}.\nPairs: ${p.pairs}; on-only wins: ${p.on_only}; off-only wins: ${p.off_only}.\n\n| Arm | Sessions | First-attempt success | Repeat failure | Mean turns | Mean tokens | Rule hit rate |\n|---|---:|---:|---:|---:|---:|---:|\n${Object.entries(
    result.arms,
  )
    .map(
      ([arm, a]) =>
        `| ${arm} | ${a.sessions} | ${a.first_attempt_success ?? 'n/a'} | ${a.repeat_failure_rate ?? 'n/a'} | ${a.mean_turns ?? 'n/a'} | ${a.mean_tokens ?? 'n/a'} | ${a.rule_hit_rate ?? 'n/a'} |`,
    )
    .join(
      '\n',
    )}\n\n## Operational-error sensitivity\n\nPrimary analysis counts ERROR as failure. After dropping every pair containing ERROR: ${result.sensitivity.pairs} pairs, lift ${result.sensitivity.risk_difference ?? 'unavailable'}, p = ${result.sensitivity.p_value ?? 'unavailable'}, 95% CI ${JSON.stringify(result.sensitivity.ci95)}.\n\nAffected pairs: ${result.error_tolerance.affected_pairs}/${result.error_tolerance.max_affected_pairs} allowed; arm errors on/off: ${result.error_tolerance.rules_on_errors}/${result.error_tolerance.rules_off_errors}; training errors: ${result.error_tolerance.training_errors}/${result.error_tolerance.max_training_errors} allowed. Operational eligibility: ${result.error_tolerance.eligible}.\n\n## Calibration\n\n\`\`\`json\n${JSON.stringify({ gate: result.calibration_gate, families: result.calibration }, null, 2)}\n\`\`\`\n\n## Interpretation\n\n${result.limitations.join('\n\n')}\n\nThe CI uses ${p.method}. A null result is inconclusive, not evidence of equivalence. See preregistration.json for the fixed plan and events.jsonl for every attempted session.\n`
}
