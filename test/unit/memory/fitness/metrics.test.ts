import { describe, expect, it } from 'bun:test'
import type { CalibrationRecord } from '../../../../src/memory/calibration/stats.ts'
import type { Episode } from '../../../../src/memory/episodes/types.ts'
import type { JournalEvent } from '../../../../src/memory/events.ts'
import type { SessionStatsRecord } from '../../../../src/memory/fitness/io.ts'
import {
  computeCalibrationTrend,
  computeCostPerResolvedTask,
  computeLedgerCoverage,
  computeRepeatFailureTrend,
  computeRuleHitRates,
  computeRulePoolHealth,
} from '../../../../src/memory/fitness/metrics.ts'
import type { RuleFile } from '../../../../src/memory/rules/types.ts'

function rule(overrides: Partial<RuleFile> = {}): RuleFile {
  return {
    id: 'rule-default',
    triggers: { tools: ['Bash'], command_prefix: ['bun test'], error_signatures: [] },
    scope: 'repo',
    alpha: 2,
    beta: 2,
    confidence: 0.5,
    evidence: [],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'src/example.ts' },
    status: 'candidate',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'test-model',
    prompt_hash: 'hash-a',
    created_at: '2026-06-01T00:00:00.000Z',
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'Test advice.',
    ...overrides,
  }
}

function episode(overrides: Partial<Episode>): Episode {
  return {
    id: 'ep-default',
    timestamp: '2026-06-01T09:00:00.000Z',
    session_id: 'seed-session',
    task_digest: 'task',
    failure: {
      tool: 'Bash',
      cmd: 'bun test',
      error_class: 'TypeError',
      signature: 'bun-test|TypeError|src/a.ts|reading x',
    },
    fix_candidates: [],
    attribution: { status: 'single_direct', confidence: 1 },
    verification: { cmd: 'bun test', exit_code: 0 },
    outcome: 'resolved',
    journal_line_range: { start: 1, end: 2 },
    value_score: 1,
    is_excluded: false,
    exclusion_reason: null,
    ...overrides,
  }
}

function toolFailure(
  sessionId: string,
  ts: string,
  medium: string,
  kind: 'tool' | 'verify' = 'tool',
): JournalEvent {
  const fingerprint = { coarse: medium.split('|').slice(0, 2).join('|'), medium, fine: medium }
  if (kind === 'verify') {
    return {
      kind: 'verify',
      schema_version: 1,
      session_id: sessionId,
      ts,
      verdict: 'FAIL',
      fingerprints: [fingerprint],
      command: 'bun test',
      exit_code: 1,
      stale: false,
    }
  }
  return {
    kind: 'tool',
    schema_version: 1,
    session_id: sessionId,
    ts,
    tool: 'Bash',
    input_digest: 'digest',
    outcome: 'failure',
    error_class: 'TypeError',
    duration_ms: 1,
    fingerprints: [fingerprint],
  }
}

function stats(sessionId: string, ts: string, cost: number, priced = true): SessionStatsRecord {
  return {
    ts,
    session_id: sessionId,
    model: 'test-model',
    turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 },
    cost_usd: cost,
    priced,
    context_utilization: 0.1,
    compact_count: 0,
    duration_ms: 100,
  }
}

describe('fitness metrics', () => {
  it('groups rule accounting by prompt hash without calling no accounting 0%', () => {
    const result = computeRuleHitRates([
      rule({ id: 'rule-a1', hits: 2, misses: 0, status: 'active' }),
      rule({ id: 'rule-a2', hits: 0, misses: 1, status: 'retired' }),
      rule({ id: 'rule-b1', prompt_hash: 'hash-b', status: 'candidate' }),
    ])

    // hash-a: hits=2, misses=1, n=3, hit-rate=2/3. Its dashboard posterior is
    // Beta(2+2, 2+1)=Beta(4,3): mean=4/7 and 95% CI≈[0.222777, 0.881883].
    expect(result[0]?.prompt_hash).toBe('hash-a')
    expect(result[0]?.rule_count).toBe(2)
    expect(result[0]?.status_counts.active).toBe(1)
    expect(result[0]?.status_counts.retired).toBe(1)
    expect(result[0]?.hits).toBe(2)
    expect(result[0]?.misses).toBe(1)
    expect(result[0]?.n).toBe(3)
    expect(result[0]?.hit_rate).toBe(2 / 3)
    expect(result[0]?.posterior_mean).toBe(4 / 7)
    expect(result[0]?.credible_interval[0]).toBeCloseTo(0.222777, 5)
    expect(result[0]?.credible_interval[1]).toBeCloseTo(0.881883, 5)

    // hash-b has no attributed injection outcome. The prior remains Beta(2,2),
    // but the empirical hit-rate is absent rather than the fabricated value 0%.
    expect(result[1]?.prompt_hash).toBe('hash-b')
    expect(result[1]?.rule_count).toBe(1)
    expect(result[1]?.status_counts.candidate).toBe(1)
    expect(result[1]?.hits).toBe(0)
    expect(result[1]?.misses).toBe(0)
    expect(result[1]?.n).toBe(0)
    expect(result[1]?.hit_rate).toBe(null)
    expect(result[1]?.posterior_mean).toBe(0.5)
  })

  it('computes walk-forward Brier and first-attempt success by UTC ISO week', () => {
    const calibration: CalibrationRecord[] = [
      {
        session_id: 'a-1',
        ts: '2026-06-01T10:00:00.000Z',
        bucket_key: 'bun-test|TypeError',
        model_id: 'model-a',
        attempt_count: 1,
        first_attempt_success: true,
        user_modifications: 0,
        user_reverts: 0,
        resolved: true,
      },
      {
        session_id: 'b-1',
        ts: '2026-06-02T10:00:00.000Z',
        bucket_key: 'tsc|SyntaxError',
        model_id: 'model-a',
        attempt_count: 1,
        first_attempt_success: false,
        user_modifications: 0,
        user_reverts: 0,
        resolved: false,
      },
      {
        session_id: 'a-2',
        ts: '2026-06-08T10:00:00.000Z',
        bucket_key: 'bun-test|TypeError',
        model_id: 'model-a',
        attempt_count: 2,
        first_attempt_success: false,
        user_modifications: 0,
        user_reverts: 0,
        resolved: true,
      },
      {
        session_id: 'b-2',
        ts: '2026-06-09T10:00:00.000Z',
        bucket_key: 'tsc|SyntaxError',
        model_id: 'model-a',
        attempt_count: 2,
        first_attempt_success: false,
        user_modifications: 0,
        user_reverts: 0,
        resolved: false,
      },
      {
        session_id: 'a-3',
        ts: '2026-06-15T10:00:00.000Z',
        bucket_key: 'bun-test|TypeError',
        model_id: 'model-a',
        attempt_count: 1,
        first_attempt_success: true,
        user_modifications: 0,
        user_reverts: 0,
        resolved: true,
      },
    ]

    const result = computeCalibrationTrend(calibration)

    // Each bucket starts Beta(2,2). Walk-forward predictions are therefore:
    // A: .5 -> .6 -> .5; B: .5 -> .4. Squared errors are
    // .25, .36, .25 and .25, .16 respectively; overall=1.27/5=.254.
    expect(result.group_count).toBe(2)
    expect(result.overall_brier).toBeCloseTo(0.254, 12)
    expect(result.weekly).toEqual([
      {
        week: '2026-W23',
        records: 2,
        brier: 0.25,
        successes: 1,
        first_attempt_success_rate: 0.5,
      },
      {
        week: '2026-W24',
        records: 2,
        brier: 0.26,
        successes: 0,
        first_attempt_success_rate: 0,
      },
      {
        week: '2026-W25',
        records: 1,
        brier: 0.25,
        successes: 1,
        first_attempt_success_rate: 1,
      },
    ])
  })

  it('counts cross-session repeats once per session and medium fingerprint', () => {
    const mediumA = 'bun-test|TypeError|src/a.ts'
    const mediumB = 'tsc|SyntaxError|src/b.ts'
    const episodes = [
      episode({}),
      episode({
        id: 'ep-same-session',
        timestamp: '2026-06-07T09:00:00.000Z',
        session_id: 'same-session',
        failure: {
          tool: 'Bash',
          cmd: 'bun run typecheck',
          error_class: 'SyntaxError',
          signature: `${mediumB}|missing brace`,
        },
      }),
    ]
    const events = [
      toolFailure('seed-session', '2026-06-01T10:00:00.000Z', mediumA),
      toolFailure('same-session', '2026-06-08T10:00:00.000Z', mediumB),
      toolFailure('cross-session', '2026-06-15T10:00:00.000Z', mediumA),
      // Same occurrence repeated in a verify event: it must still count once.
      toolFailure('cross-session', '2026-06-15T10:01:00.000Z', mediumA, 'verify'),
    ]

    const result = computeRepeatFailureTrend(events, episodes)

    // W23 is the seed occurrence. W24 has only a same-session prior episode,
    // so it is not a repeat. W25 matches W23's earlier resolved other session.
    expect(result).toEqual([
      { week: '2026-W23', occurrences: 1, repeats: 0, repeat_failure_rate: 0 },
      { week: '2026-W24', occurrences: 1, repeats: 0, repeat_failure_rate: 0 },
      { week: '2026-W25', occurrences: 1, repeats: 1, repeat_failure_rate: 1 },
    ])
  })

  it('reports pool-cap utilization, confidence distribution, concentration, and staleness', () => {
    const rules = [
      rule({
        id: 'active-newer',
        status: 'active',
        confidence: 0.8,
        hits: 10,
        last_matched_at: '2026-06-20T00:00:00.000Z',
      }),
      rule({
        id: 'active-oldest',
        status: 'active',
        confidence: 0.6,
        hits: 5,
        last_matched_at: '2026-06-01T00:00:00.000Z',
      }),
      rule({ id: 'candidate', status: 'candidate', confidence: 0.4, hits: 3 }),
      rule({ id: 'retired', status: 'retired', confidence: 0.2, hits: 2 }),
      rule({ id: 'banned', status: 'banned', confidence: 0.99, hits: 1 }),
      rule({
        id: 'pinned',
        status: 'pinned',
        confidence: 0.5,
        hits: 1,
        last_matched_at: '2026-06-15T00:00:00.000Z',
      }),
    ]

    const result = computeRulePoolHealth(rules, new Date('2026-07-01T00:00:00.000Z'))

    // Cap-relevant means active+candidate: 3/150=.02. Non-banned confidences
    // sort to [.2,.4,.5,.6,.8], whose median and mean are both .5.
    // Total hits=22 and the top five carry 21, so concentration=21/22.
    expect(result).toEqual({
      rule_count: 6,
      status_counts: {
        candidate: 1,
        active: 2,
        retired: 1,
        dormant: 0,
        pinned: 1,
        banned: 1,
        superseded: 0,
      },
      cap: 150,
      cap_relevant_count: 3,
      cap_utilization: 0.02,
      confidence: { min: 0.2, median: 0.5, mean: 0.5, max: 0.8 },
      hit_concentration_top_5: 21 / 22,
      never_matched_count: 3,
      oldest_active_last_matched_at: '2026-06-01T00:00:00.000Z',
      oldest_active_staleness_days: 30,
    })
  })

  it('computes weekly cost per resolved episode with unpriced sessions excluded', () => {
    const mediumA = 'bun-test|TypeError|src/a.ts'
    const episodes = [
      episode({
        id: 'ep-1',
        session_id: 's1',
        timestamp: '2026-06-01T10:00:00Z',
        failure: {
          tool: 'Bash',
          cmd: 'bun test',
          error_class: 'TypeError',
          signature: `${mediumA}|reading x`,
        },
      }),
      episode({
        id: 'ep-2',
        session_id: 's2',
        timestamp: '2026-06-02T10:00:00Z',
        outcome: 'abandoned',
        failure: {
          tool: 'Bash',
          cmd: 'bun test',
          error_class: 'TypeError',
          signature: `${mediumA}|reading y`,
        },
      }),
      episode({
        id: 'ep-3',
        session_id: 's3',
        timestamp: '2026-06-08T10:00:00Z',
        failure: {
          tool: 'Bash',
          cmd: 'bun test',
          error_class: 'TypeError',
          signature: `${mediumA}|reading z`,
        },
      }),
      episode({
        id: 'ep-4',
        session_id: 's5',
        timestamp: '2026-06-15T10:00:00Z',
        failure: {
          tool: 'Bash',
          cmd: 'bun run typecheck',
          error_class: 'SyntaxError',
          signature: 'tsc|SyntaxError|src/b.ts|missing brace',
        },
      }),
    ]
    const rows = [
      stats('s1', '2026-06-01T12:00:00Z', 12),
      stats('s2', '2026-06-02T12:00:00Z', 50, false),
      stats('s3', '2026-06-08T12:00:00Z', 6),
      stats('s4', '2026-06-09T12:00:00Z', 4),
      stats('s5', '2026-06-15T12:00:00Z', 2),
    ]

    const result = computeCostPerResolvedTask(episodes, rows)

    // W23 has two episode-bearing sessions but s2 is unpriced: $12/1 resolved=$12.
    // W24 has $6 episode cost / 1 resolved, while all sessions cost $6+$4=$10.
    // W25's second bucket has $2/1 resolved. The $50 unpriced row is never summed.
    expect(result).toEqual({
      unpriced_session_count: 1,
      weekly: [
        {
          week: '2026-W23',
          resolved_episode_count: 1,
          episode_bearing_session_cost_usd: 12,
          unit_cost_usd: 12,
          all_sessions_cost_usd: 12,
          unpriced_session_count: 1,
        },
        {
          week: '2026-W24',
          resolved_episode_count: 1,
          episode_bearing_session_cost_usd: 6,
          unit_cost_usd: 6,
          all_sessions_cost_usd: 10,
          unpriced_session_count: 0,
        },
        {
          week: '2026-W25',
          resolved_episode_count: 1,
          episode_bearing_session_cost_usd: 2,
          unit_cost_usd: 2,
          all_sessions_cost_usd: 2,
          unpriced_session_count: 0,
        },
      ],
    })

    const bucketResult = computeCostPerResolvedTask(episodes, rows, 'bun-test|TypeError')
    expect(bucketResult.weekly[2]).toEqual({
      week: '2026-W25',
      resolved_episode_count: 0,
      episode_bearing_session_cost_usd: null,
      unit_cost_usd: null,
      all_sessions_cost_usd: 2,
      unpriced_session_count: 0,
    })
  })

  it('summarizes ledger coverage from loaded records', () => {
    const events = [
      toolFailure('session-a', '2026-06-08T10:00:00Z', 'bun-test|TypeError|src/a.ts'),
      toolFailure('session-b', '2026-06-01T10:00:00Z', 'tsc|SyntaxError|src/b.ts'),
      toolFailure('session-a', '2026-06-15T10:00:00Z', 'bun-test|TypeError|src/c.ts'),
    ]

    const result = computeLedgerCoverage(
      { line_count: 4, events },
      [episode({ id: 'ep-1' }), episode({ id: 'ep-2' })],
      [
        {
          session_id: 'session-a',
          ts: '2026-06-01T00:00:00Z',
          bucket_key: 'bun-test|TypeError',
          model_id: 'model-a',
          attempt_count: 1,
          first_attempt_success: true,
          user_modifications: 0,
          user_reverts: 0,
          resolved: true,
        },
      ],
      { row_count: 3, records: [] },
    )

    expect(result).toEqual({
      journal_first_ts: '2026-06-01T10:00:00Z',
      journal_last_ts: '2026-06-15T10:00:00Z',
      distinct_session_count: 2,
      journal_line_count: 4,
      episode_count: 2,
      calibration_record_count: 1,
      stats_row_count: 3,
    })
  })
})
