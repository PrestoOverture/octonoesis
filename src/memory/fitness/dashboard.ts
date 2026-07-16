import type { CalibrationRecord } from '../calibration/stats.ts'
import type { Episode } from '../episodes/types.ts'
import type { RuleFile } from '../rules/types.ts'
import type { JournalReadResult, StatsReadResult } from './io.ts'
import {
  computeCalibrationTrend,
  computeCostPerResolvedTask,
  computeLedgerCoverage,
  computeRepeatFailureTrend,
  computeRuleHitRates,
  computeRulePoolHealth,
} from './metrics.ts'
import type { FitnessDashboard } from './schema.ts'

export interface FitnessInput {
  journal: JournalReadResult
  episodes: Episode[]
  rules: RuleFile[]
  calibration_records: CalibrationRecord[]
  stats: StatsReadResult
}

export interface FitnessDashboardOptions {
  now: Date
  weeks?: number
  bucket?: string
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function isoWeekStart(timestamp: string): number | null {
  const source = new Date(timestamp)
  if (Number.isNaN(source.getTime())) return null
  const date = new Date(
    Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()),
  )
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() - day + 1)
  return date.getTime()
}

function inTrailingWeeks(timestamp: string | undefined, weeks: number | undefined, now: Date) {
  if (weeks === undefined) return true
  if (!timestamp) return false
  const recordWeek = isoWeekStart(timestamp)
  const currentWeek = isoWeekStart(now.toISOString())
  if (recordWeek === null || currentWeek === null) return false
  const earliestWeek = currentWeek - (weeks - 1) * WEEK_MS
  return recordWeek >= earliestWeek && recordWeek <= currentWeek
}

export function buildFitnessDashboard(
  input: FitnessInput,
  options: FitnessDashboardOptions,
): FitnessDashboard {
  if (options.weeks !== undefined && (!Number.isInteger(options.weeks) || options.weeks < 1)) {
    throw new Error('--weeks must be a positive integer')
  }
  const asOf = options.now.toISOString()
  const bucket = options.bucket?.trim() || undefined
  const calibrationRecords = input.calibration_records.filter((record) =>
    inTrailingWeeks(record.ts, options.weeks, options.now),
  )
  const occurrenceEvents = input.journal.events.filter((event) =>
    inTrailingWeeks(event.ts, options.weeks, options.now),
  )
  const costEpisodes = input.episodes.filter((episode) =>
    inTrailingWeeks(episode.timestamp, options.weeks, options.now),
  )
  const costStats = input.stats.records.filter((record) =>
    inTrailingWeeks(record.ts, options.weeks, options.now),
  )

  return {
    schema_version: 1,
    as_of: asOf,
    filters: { weeks: options.weeks ?? null, bucket: bucket ?? null },
    ledger_coverage: computeLedgerCoverage(
      input.journal,
      input.episodes,
      input.calibration_records,
      input.stats,
    ),
    rule_hit_rate_by_prompt_hash: computeRuleHitRates(input.rules),
    calibration_trend: computeCalibrationTrend(calibrationRecords),
    repeat_failure_rate_trend: computeRepeatFailureTrend(occurrenceEvents, input.episodes),
    rule_pool_health: computeRulePoolHealth(input.rules, options.now),
    cost_per_resolved_task: computeCostPerResolvedTask(costEpisodes, costStats, bucket),
  }
}

export function formatFitnessJson(report: FitnessDashboard): string {
  return JSON.stringify(report, null, 2)
}
