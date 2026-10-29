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

export function report(plan: Plan, rows: Observation[]) {
  for (const row of rows) {
    const expected = plan.jobs.find((job) => job.id === row.job.id)
    if (!expected || JSON.stringify(expected) !== JSON.stringify(row.job))
      throw new Error('Observation does not match preregistered arm/task')
  }
  const primary = pairedStats(rows)
  const training = rows.filter((r) => r.job.arm === 'train')
  const reasons: string[] = []
  if (plan.mode === 'dry-run')
    reasons.push('Scripted mock provider: pipeline demonstration, not model efficacy evidence.')
  if (rows.length !== plan.jobs.length || primary.pairs !== plan.sample_size.pairs)
    reasons.push('Fixed sample incomplete.')
  if (rows.some((r) => r.status === 'ERROR'))
    reasons.push('Operational errors or interrupted sessions: no confirmatory verdict.')
  const calibration = Object.fromEntries(
    [...new Set(plan.tasks.map((t) => t.family))].map((family) => {
      const group = training.filter((r) => r.job.task.family === family)
      const failures = group.filter((r) => r.status !== 'PASS').length
      const rate = group.length ? failures / group.length : null
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
      if (
        rate === null ||
        rate < plan.calibration.min_failure_rate ||
        rate > plan.calibration.max_failure_rate
      )
        reasons.push(
          `${family}: training first-submission failure rate outside preregistered calibration range.`,
        )
      if (!recurring.length)
        reasons.push(`${family}: no observed recurring production fingerprint class.`)
      return [
        family,
        { sessions: group.length, failures, failure_rate: rate, recurring_fingerprints: recurring },
      ]
    }),
  )
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
    arms,
    calibration,
    planned_jobs: plan.jobs.length,
    completed_jobs: rows.length,
    preregistration: plan,
    limitations: [
      'First attempt means first completed headless session submission; local edit/test retries are allowed.',
      'Conditional on one trained ledger, three synthetic task families and a fixed provider/model. No R1 parameter search or R2 distiller comparison is performed.',
      'Rule hit rate uses production signature-flip accounting; repeat failures use observed coarse fingerprints from previously trained sessions, not hidden oracle labels.',
    ],
  }
}

export function markdown(result: ReturnType<typeof report>): string {
  const p = result.primary
  return `# Dogfood / RSC measurement\n\nVerdict: **${result.verdict}** (${result.mode})\n\n${result.reasons.map((r) => `- ${r}`).join('\n')}\n\nPaired first-submission success lift (rules-on minus rules-off): ${p.risk_difference === null ? 'unavailable' : `${(100 * p.risk_difference).toFixed(1)} percentage points`}.\n95% CI: ${p.ci95 ? `[${p.ci95.map((v) => (100 * v).toFixed(1)).join(', ')}] percentage points` : 'unavailable'}; exact two-sided p = ${p.p_value ?? 'unavailable'}.\nPairs: ${p.pairs}; on-only wins: ${p.on_only}; off-only wins: ${p.off_only}.\n\n| Arm | Sessions | First-attempt success | Repeat failure | Mean turns | Mean tokens | Rule hit rate |\n|---|---:|---:|---:|---:|---:|---:|\n${Object.entries(
    result.arms,
  )
    .map(
      ([arm, a]) =>
        `| ${arm} | ${a.sessions} | ${a.first_attempt_success ?? 'n/a'} | ${a.repeat_failure_rate ?? 'n/a'} | ${a.mean_turns ?? 'n/a'} | ${a.mean_tokens ?? 'n/a'} | ${a.rule_hit_rate ?? 'n/a'} |`,
    )
    .join(
      '\n',
    )}\n\n## Calibration\n\n\`\`\`json\n${JSON.stringify(result.calibration, null, 2)}\n\`\`\`\n\n## Interpretation\n\n${result.limitations.join('\n\n')}\n\nThe CI uses ${p.method}. A null result is inconclusive, not evidence of equivalence. See preregistration.json for the fixed plan and events.jsonl for every attempted session.\n`
}
