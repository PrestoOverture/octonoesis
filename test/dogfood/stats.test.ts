import { expect, test } from 'bun:test'
import { CALIBRATION_RULE } from './calibration'
import type { Observation, Plan } from './model'
import { clusterStats, markdown, mcnemar, pairedStats, planningPower, report } from './stats'
import { digest, families, generateStream } from './tasks'

function synthetic(on: (i: number) => boolean, off: (i: number) => boolean) {
  const tasks = generateStream(6 * families.length, 120)
  const jobs: Plan['jobs'] = tasks.flatMap<Plan['jobs'][number]>((task) =>
    task.split === 'train'
      ? [{ id: task.id, task, arm: 'train' as const }]
      : (['rules-on', 'rules-off'] as const).map((arm) => ({ id: `${task.id}-${arm}`, task, arm })),
  )
  const plan: Plan = {
    version: 1,
    stream_seed: 1,
    mode: 'live',
    provider: 'spark',
    model: 'synthetic',
    registered_at: '2026-10-29T00:00:00Z',
    source_hash: 'synthetic',
    stream_hash: digest(tasks),
    tasks,
    jobs,
    hypothesis: 'synthetic',
    metrics: {},
    test: 'McNemar',
    sample_size: { training: 6 * families.length, pairs: 120 },
    stopping_rule: 'fixed',
    evaluation_concurrency: 1,
    error_tolerance: {
      max_pair_fraction: 0.05,
      max_arm_count_difference: 1,
      max_training_fraction: 0.05,
    },
    calibration: { ...CALIBRATION_RULE },
  }
  const rows: Observation[] = jobs.map((job) => {
    const i = Number(job.task.id.split('-')[1])
    // Swap two variant positions to avoid an artificially zero family variance.
    const k = i === 34 ? 38 : i === 38 ? 34 : i
    const pass =
      job.arm === 'train'
        ? Math.floor(i / families.length) % 2 === 0
        : job.arm === 'rules-on'
          ? on(k)
          : off(k)
    return {
      job,
      status: pass ? 'PASS' : 'FAIL',
      fingerprints: [`bun-test|${job.task.family}Error`],
      hits: job.arm === 'rules-on' ? 1 : 0,
      misses: 0,
      rules_before: job.arm === 'rules-off' ? 0 : 3,
      ledger: 'synthetic',
      hidden_status: 'PASS',
      observed_repair_failure: !pass,
      observed_repair_resolution: !pass,
      first_attempt: {
        source_hash: 'synthetic',
        public_status: pass ? 'PASS' : 'FAIL',
        hidden_status: pass ? 'PASS' : 'FAIL',
      },
    }
  })
  return { plan, rows }
}

test('planted paired effect detected with effect size, CI, p-value and arm summaries', () => {
  const { plan, rows } = synthetic(
    (i) => i < 96,
    (i) => i < 36,
  )
  const result = report(plan, rows)
  expect(result.verdict).toBe('helps')
  expect(result.primary.risk_difference).toBeCloseTo(0.5)
  expect(result.primary.p_value).toBeLessThan(0.001)
  expect(result.primary.ci95?.[0]).toBeGreaterThan(0)
  expect(result.arms['rules-on']?.first_attempt_success).toBeCloseTo(0.8)
  expect(result.arms['rules-off']?.first_attempt_success).toBeCloseTo(0.3)
  expect(markdown(result)).toContain('helps')
})

test('null is inconclusive; identical pooled totals with swapped arms reverse effect and verdict', () => {
  const nullData = synthetic(
    (i) => i % 2 === 0,
    (i) => i % 2 === 0,
  )
  const nullResult = report(nullData.plan, nullData.rows)
  expect(nullResult.verdict).toBe('inconclusive')
  expect(nullResult.primary.p_value).toBe(1)
  expect(nullResult.primary.ci95?.[0]).toBeLessThan(0)
  expect(nullResult.primary.ci95?.[1]).toBeGreaterThan(0)
  const good = synthetic(
    (i) => i < 96,
    (i) => i < 36,
  )
  const bad = synthetic(
    (i) => i < 36,
    (i) => i < 96,
  )
  expect(report(good.plan, good.rows).verdict).toBe('helps')
  expect(report(bad.plan, bad.rows).verdict).toBe('harms')
  expect(pairedStats(good.rows).risk_difference).toBe(
    -Number(pairedStats(bad.rows).risk_difference),
  )
})

test('pairing and arm labels matter even with identical marginal successes', () => {
  const a = synthetic(
    (i) => i < 64,
    (i) => i < 56,
  )
  const b = synthetic(
    (i) => i < 64,
    (i) => i >= 64,
  )
  // Same 64 and 56 successes; 8 versus 120 discordant pairs.
  expect(pairedStats(a.rows).p_value).toBeLessThan(0.05)
  expect(pairedStats(b.rows).p_value).toBeGreaterThan(0.05)
  expect(() =>
    pairedStats([...a.rows, a.rows.find((r) => r.job.arm === 'rules-on') as Observation]),
  ).toThrow('Duplicate')
})

test('incomplete, uncalibrated, mock, missing-rule and operational-error runs cannot claim a win', () => {
  const { plan, rows } = synthetic(
    (i) => i < 96,
    (i) => i < 36,
  )
  expect(report(plan, rows.slice(0, -1)).verdict).toBe('inconclusive')
  expect(report({ ...plan, mode: 'dry-run' }, rows).verdict).toBe('inconclusive')
  expect(
    report(
      plan,
      rows.map((r) => (r.job.arm === 'train' ? { ...r, status: 'PASS' } : r)),
    ).verdict,
  ).toBe('inconclusive')
  expect(
    report(
      plan,
      rows.map((r) => ({ ...r, fingerprints: [] })),
    ).verdict,
  ).toBe('inconclusive')
  expect(
    report(
      plan,
      rows.map((r) => ({ ...r, rules_before: 0 })),
    ).verdict,
  ).toBe('inconclusive')
  expect(
    report(
      plan,
      rows.map((r, i) => (i < 4 ? { ...r, status: 'ERROR' } : r)),
    ).verdict,
  ).toBe('inconclusive')
  expect(() =>
    report(
      plan,
      rows.map((r, i) =>
        i === 6 * families.length ? { ...r, job: { ...r.job, arm: 'train' } } : r,
      ),
    ),
  ).toThrow('preregistered')
})

test('exact McNemar sanity checks and preregistered sample power', () => {
  expect(mcnemar(0, 0)).toBe(1)
  expect(mcnemar(8, 0)).toBeCloseTo(2 / 256)
  expect(mcnemar(0, 8)).toBeCloseTo(2 / 256)
  expect(mcnemar(20, 20)).toBeCloseTo(1)
  const power = planningPower(120)
  expect(power).toBeGreaterThan(0.8)
  expect(power).toBeLessThan(0.95)
  expect(planningPower(120, 0)).toBeLessThan(0.05)
})

test('error tolerance is inclusive at 5% of pairs and rejects the next pair or arm imbalance', () => {
  const { plan, rows } = synthetic(
    (i) => i < 96,
    (i) => i < 36,
  )
  const withErrors = (count: number, onCount = Math.ceil(count / 2)) =>
    rows.map((r) => {
      const i = Number(r.job.task.id.split('-')[1])
      const error =
        r.job.arm === 'rules-on'
          ? i < onCount
          : r.job.arm === 'rules-off' && i >= onCount && i < count
      return error ? { ...r, status: 'ERROR' as const } : r
    })
  const boundary = report(plan, withErrors(6))
  expect(boundary.error_tolerance.affected_pairs).toBe(6)
  expect(boundary.error_tolerance.eligible).toBe(true)
  expect(boundary.primary.pairs).toBe(120)
  expect(boundary.primary.on_successes).toBe(93)
  expect(boundary.primary.off_successes).toBe(33)
  expect(boundary.sensitivity.pairs).toBe(114)
  expect(boundary.verdict).toBe('helps')
  expect(report(plan, withErrors(7)).error_tolerance.eligible).toBe(false)
  expect(report(plan, withErrors(7)).verdict).toBe('inconclusive')
  expect(report(plan, withErrors(6, 4)).error_tolerance.eligible).toBe(false)
  expect(
    report(
      plan,
      rows.map((r, i) => (i === 0 ? { ...r, status: 'ERROR' } : r)),
    ).error_tolerance.eligible,
  ).toBe(true)
  expect(
    report(
      plan,
      rows.map((r, i) => (i < 4 ? { ...r, status: 'ERROR' } : r)),
    ).error_tolerance.eligible,
  ).toBe(false)
})

function clusterRows(effects: number[], pairsPerFamily = 40): Observation[] {
  return generateStream(families.length, families.length * pairsPerFamily)
    .filter((t) => t.split === 'heldout')
    .flatMap((task) => {
      const g = families.indexOf(task.family)
      const effect = effects[g] as number
      const i = Math.floor(Number(task.id.split('-')[1]) / families.length)
      const discordant = i < Math.round(Math.abs(effect) * pairsPerFamily)
      return (['rules-on', 'rules-off'] as const).map((arm) => ({
        job: { id: `${task.id}-${arm}`, task, arm },
        status:
          discordant && (arm === 'rules-on') === effect > 0 ? ('PASS' as const) : ('FAIL' as const),
        fingerprints: [],
        hits: 0,
        misses: 0,
        rules_before: 1,
        ledger: 'simulated',
      }))
    })
}
test('strong within-family correlation widens primary CI versus naive McNemar and reports family effects', () => {
  const rows = clusterRows([1, 1, 1, 1, 1, 1, 1, -1, -1, -1], 100)
  const clustered = clusterStats(rows)
  const naive = pairedStats(rows)
  expect(clustered.clusters).toBe(10)
  expect(clustered.degrees_of_freedom).toBe(9)
  expect(Object.keys(clustered.per_family).length).toBe(10)
  expect(clustered.risk_difference).toBeCloseTo(0.4)
  expect((clustered.ci95?.[1] as number) - (clustered.ci95?.[0] as number)).toBeGreaterThan(
    (naive.ci95?.[1] as number) - (naive.ci95?.[0] as number),
  )
  expect(clustered.p_value).toBeGreaterThan(0.05)
  expect(naive.p_value).toBeLessThan(0.001)
})
test('family-cluster test controls simulated null type-I error despite perfectly correlated variants', () => {
  let state = 18433
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  let rejected = 0
  const simulations = 2000
  // Null draws independent families with symmetric effects, but all 20 paired
  // differences within each family agree: ICC = 1. No outcome-driven tuning.
  for (let run = 0; run < simulations; run++) {
    const effects = families.map(() => (random() < 0.5 ? -1 : 1))
    if ((clusterStats(clusterRows(effects, 20)).p_value as number) < 0.05) rejected++
  }
  // Exact null rejection probability for G=10 Rademacher means is 22/1024.
  expect(rejected / simulations).toBeLessThan(0.05)
  expect(rejected / simulations).toBeGreaterThan(0.005)
})
test('Student-t tails and critical values agree with tabulated values', async () => {
  const { studentCritical, studentTwoSided } = await import('./distributions')
  expect(studentCritical(9)).toBeCloseTo(2.2621571628, 8)
  expect(studentCritical(1)).toBeCloseTo(12.7062047364, 8)
  expect(studentTwoSided(1, 1)).toBeCloseTo(0.5, 10)
  expect(studentTwoSided(0, 9)).toBe(1)
  expect(studentTwoSided(2.2621571628, 9)).toBeCloseTo(0.05, 9)
})
