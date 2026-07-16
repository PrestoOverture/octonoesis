import { z } from 'zod'

const ruleStatusCountsSchema = z.object({
  candidate: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  retired: z.number().int().nonnegative(),
  dormant: z.number().int().nonnegative(),
  pinned: z.number().int().nonnegative(),
  banned: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
})

const weeklyCalibrationSchema = z.object({
  week: z.string(),
  records: z.number().int().nonnegative(),
  brier: z.number().nonnegative(),
  successes: z.number().int().nonnegative(),
  first_attempt_success_rate: z.number().min(0).max(1),
})

export const fitnessDashboardSchema = z.object({
  schema_version: z.literal(1),
  as_of: z.string(),
  filters: z.object({
    weeks: z.number().int().positive().nullable(),
    bucket: z.string().nullable(),
  }),
  ledger_coverage: z.object({
    journal_first_ts: z.string().nullable(),
    journal_last_ts: z.string().nullable(),
    distinct_session_count: z.number().int().nonnegative(),
    journal_line_count: z.number().int().nonnegative(),
    episode_count: z.number().int().nonnegative(),
    calibration_record_count: z.number().int().nonnegative(),
    stats_row_count: z.number().int().nonnegative(),
  }),
  rule_hit_rate_by_prompt_hash: z.array(
    z.object({
      prompt_hash: z.string(),
      rule_count: z.number().int().nonnegative(),
      status_counts: ruleStatusCountsSchema,
      hits: z.number().nonnegative(),
      misses: z.number().nonnegative(),
      n: z.number().nonnegative(),
      hit_rate: z.number().min(0).max(1).nullable(),
      posterior_mean: z.number().min(0).max(1),
      credible_interval: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    }),
  ),
  calibration_trend: z.object({
    group_count: z.number().int().nonnegative(),
    overall_brier: z.number().nonnegative().nullable(),
    weekly: z.array(weeklyCalibrationSchema),
  }),
  repeat_failure_rate_trend: z.array(
    z.object({
      week: z.string(),
      occurrences: z.number().int().nonnegative(),
      repeats: z.number().int().nonnegative(),
      repeat_failure_rate: z.number().min(0).max(1),
    }),
  ),
  rule_pool_health: z.object({
    rule_count: z.number().int().nonnegative(),
    status_counts: ruleStatusCountsSchema,
    cap: z.literal(150),
    cap_relevant_count: z.number().int().nonnegative(),
    cap_utilization: z.number().min(0),
    confidence: z
      .object({ min: z.number(), median: z.number(), mean: z.number(), max: z.number() })
      .nullable(),
    hit_concentration_top_5: z.number().min(0).max(1).nullable(),
    never_matched_count: z.number().int().nonnegative(),
    oldest_active_last_matched_at: z.string().nullable(),
    oldest_active_staleness_days: z.number().nonnegative().nullable(),
  }),
  cost_per_resolved_task: z.object({
    unpriced_session_count: z.number().int().nonnegative(),
    weekly: z.array(
      z.object({
        week: z.string(),
        resolved_episode_count: z.number().int().nonnegative(),
        episode_bearing_session_cost_usd: z.number().nonnegative().nullable(),
        unit_cost_usd: z.number().nonnegative().nullable(),
        all_sessions_cost_usd: z.number().nonnegative().nullable(),
        unpriced_session_count: z.number().int().nonnegative(),
      }),
    ),
  }),
})

export type FitnessDashboard = z.infer<typeof fitnessDashboardSchema>
