import { createPrior, credibleInterval, posteriorMean, update } from '../calibration/beta.ts'
import { type CalibrationRecord, aggregateCalibrationStats } from '../calibration/stats.ts'
import type { Episode } from '../episodes/types.ts'
import type { JournalEvent } from '../events.ts'
import { isPoolCapRelevantStatus } from '../rules/pool.ts'
import type { RuleFile, RuleStatus } from '../rules/types.ts'
import type { JournalReadResult, SessionStatsRecord, StatsReadResult } from './io.ts'

export const RULE_STATUSES: RuleStatus[] = [
  'candidate',
  'active',
  'retired',
  'dormant',
  'pinned',
  'banned',
  'superseded',
]

export type RuleStatusCounts = Record<RuleStatus, number>

export interface PromptHashHitRate {
  prompt_hash: string
  rule_count: number
  status_counts: RuleStatusCounts
  hits: number
  misses: number
  n: number
  hit_rate: number | null
  posterior_mean: number
  credible_interval: [number, number]
}

export interface WeeklyCalibrationTrend {
  week: string
  records: number
  brier: number
  successes: number
  first_attempt_success_rate: number
}

export interface CalibrationTrend {
  group_count: number
  overall_brier: number | null
  weekly: WeeklyCalibrationTrend[]
}

export interface WeeklyRepeatFailureTrend {
  week: string
  occurrences: number
  repeats: number
  repeat_failure_rate: number
}

export interface RulePoolHealth {
  rule_count: number
  status_counts: RuleStatusCounts
  cap: 150
  cap_relevant_count: number
  cap_utilization: number
  confidence: { min: number; median: number; mean: number; max: number } | null
  hit_concentration_top_5: number | null
  never_matched_count: number
  oldest_active_last_matched_at: string | null
  oldest_active_staleness_days: number | null
}

export interface WeeklyCostPerResolvedTask {
  week: string
  resolved_episode_count: number
  episode_bearing_session_cost_usd: number | null
  unit_cost_usd: number | null
  all_sessions_cost_usd: number | null
  unpriced_session_count: number
}

export interface CostPerResolvedTask {
  unpriced_session_count: number
  weekly: WeeklyCostPerResolvedTask[]
}

export interface LedgerCoverage {
  journal_first_ts: string | null
  journal_last_ts: string | null
  distinct_session_count: number
  journal_line_count: number
  episode_count: number
  calibration_record_count: number
  stats_row_count: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function roundMetric(value: number): number {
  return Number(value.toFixed(12))
}

export function toIsoWeek(timestamp: string): string | null {
  const source = new Date(timestamp)
  if (Number.isNaN(source.getTime())) return null

  const date = new Date(
    Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()),
  )
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const isoYear = date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(isoYear, 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7)
  return `${isoYear}-W${week.toString().padStart(2, '0')}`
}

function emptyStatusCounts(): RuleStatusCounts {
  return {
    candidate: 0,
    active: 0,
    retired: 0,
    dormant: 0,
    pinned: 0,
    banned: 0,
    superseded: 0,
  }
}

export function computeRuleHitRates(rules: RuleFile[]): PromptHashHitRate[] {
  const groups = new Map<string, RuleFile[]>()
  for (const rule of rules) {
    const group = groups.get(rule.prompt_hash) ?? []
    group.push(rule)
    groups.set(rule.prompt_hash, group)
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([promptHash, group]) => {
      const statusCounts = emptyStatusCounts()
      let hits = 0
      let misses = 0
      for (const rule of group) {
        statusCounts[rule.status] += 1
        hits += rule.hits
        misses += rule.misses
      }
      const n = hits + misses
      const posterior = { alpha: 2 + hits, beta: 2 + misses }

      return {
        prompt_hash: promptHash,
        rule_count: group.length,
        status_counts: statusCounts,
        hits,
        misses,
        n,
        hit_rate: n === 0 ? null : hits / n,
        posterior_mean: posteriorMean(posterior),
        credible_interval: credibleInterval(posterior),
      }
    })
}

export function computeCalibrationTrend(records: CalibrationRecord[]): CalibrationTrend {
  const ordered = records
    .map((record, index) => ({
      record,
      index,
      timestamp: new Date(record.ts).getTime(),
      week: toIsoWeek(record.ts),
    }))
    .filter(
      (entry): entry is typeof entry & { week: string } =>
        entry.week !== null && !Number.isNaN(entry.timestamp),
    )
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)

  const groupCount = aggregateCalibrationStats(ordered.map(({ record }) => record)).length
  const posteriors = new Map<string, ReturnType<typeof createPrior>>()
  const weekly = new Map<string, { records: number; squaredError: number; successes: number }>()
  let totalSquaredError = 0

  for (const { record, week } of ordered) {
    const groupKey = JSON.stringify([record.bucket_key, record.model_id])
    const prior = posteriors.get(groupKey) ?? createPrior()
    const prediction = posteriorMean(prior)
    const outcome = record.first_attempt_success ? 1 : 0
    const squaredError = (prediction - outcome) ** 2
    const weekStats = weekly.get(week) ?? { records: 0, squaredError: 0, successes: 0 }
    weekStats.records += 1
    weekStats.squaredError += squaredError
    weekStats.successes += outcome
    weekly.set(week, weekStats)
    totalSquaredError += squaredError
    posteriors.set(groupKey, update(prior, record.first_attempt_success))
  }

  return {
    group_count: groupCount,
    overall_brier: ordered.length === 0 ? null : roundMetric(totalSquaredError / ordered.length),
    weekly: [...weekly.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([week, stats]) => ({
        week,
        records: stats.records,
        brier: roundMetric(stats.squaredError / stats.records),
        successes: stats.successes,
        first_attempt_success_rate: roundMetric(stats.successes / stats.records),
      })),
  }
}

function fingerprintMedium(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const medium = (value as { medium?: unknown }).medium
  return typeof medium === 'string' && medium.length > 0 ? medium : null
}

export function computeRepeatFailureTrend(
  events: JournalEvent[],
  episodes: Episode[],
): WeeklyRepeatFailureTrend[] {
  const occurrences = new Map<
    string,
    { sessionId: string; medium: string; timestamp: number; week: string }
  >()

  for (const event of events) {
    if (event.kind !== 'tool' && event.kind !== 'verify') continue
    if (!event.session_id || !event.ts) continue
    const timestamp = new Date(event.ts).getTime()
    const week = toIsoWeek(event.ts)
    if (Number.isNaN(timestamp) || !week) continue

    for (const fingerprint of event.fingerprints ?? []) {
      const medium = fingerprintMedium(fingerprint)
      if (!medium) continue
      const key = JSON.stringify([event.session_id, medium])
      const existing = occurrences.get(key)
      if (!existing || timestamp < existing.timestamp) {
        occurrences.set(key, { sessionId: event.session_id, medium, timestamp, week })
      }
    }
  }

  const priorResolvedEpisodes = episodes
    .filter((episode) => episode.outcome === 'resolved' && !episode.is_excluded)
    .map((episode) => ({ episode, timestamp: new Date(episode.timestamp).getTime() }))
    .filter(({ timestamp }) => !Number.isNaN(timestamp))

  const weekly = new Map<string, { occurrences: number; repeats: number }>()
  for (const occurrence of occurrences.values()) {
    const isRepeat = priorResolvedEpisodes.some(
      ({ episode, timestamp }) =>
        episode.session_id !== occurrence.sessionId &&
        timestamp < occurrence.timestamp &&
        (episode.failure.signature === occurrence.medium ||
          episode.failure.signature.startsWith(`${occurrence.medium}|`)),
    )
    const weekStats = weekly.get(occurrence.week) ?? { occurrences: 0, repeats: 0 }
    weekStats.occurrences += 1
    weekStats.repeats += isRepeat ? 1 : 0
    weekly.set(occurrence.week, weekStats)
  }

  return [...weekly.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([week, stats]) => ({
      week,
      occurrences: stats.occurrences,
      repeats: stats.repeats,
      repeat_failure_rate: roundMetric(stats.repeats / stats.occurrences),
    }))
}

export function computeRulePoolHealth(rules: RuleFile[], now: Date): RulePoolHealth {
  const statusCounts = emptyStatusCounts()
  for (const rule of rules) statusCounts[rule.status] += 1

  const cap = 150 as const
  const capRelevantCount = rules.filter((rule) => isPoolCapRelevantStatus(rule.status)).length
  const confidences = rules
    .filter((rule) => rule.status !== 'banned')
    .map((rule) => rule.confidence)
    .sort((left, right) => left - right)
  let confidence: RulePoolHealth['confidence'] = null
  if (confidences.length > 0) {
    const middle = Math.floor(confidences.length / 2)
    const median =
      confidences.length % 2 === 1
        ? (confidences[middle] ?? 0)
        : ((confidences[middle - 1] ?? 0) + (confidences[middle] ?? 0)) / 2
    confidence = {
      min: confidences[0] ?? 0,
      median: roundMetric(median),
      mean: roundMetric(confidences.reduce((sum, value) => sum + value, 0) / confidences.length),
      max: confidences[confidences.length - 1] ?? 0,
    }
  }

  const hitCounts = rules.map((rule) => rule.hits).sort((left, right) => right - left)
  const totalHits = hitCounts.reduce((sum, value) => sum + value, 0)
  const topFiveHits = hitCounts.slice(0, 5).reduce((sum, value) => sum + value, 0)
  const activeMatches = rules
    .filter((rule) => rule.status === 'active' && rule.last_matched_at !== null)
    .map((rule) => ({
      timestamp: rule.last_matched_at as string,
      time: new Date(rule.last_matched_at as string).getTime(),
    }))
    .filter(({ time }) => !Number.isNaN(time))
    .sort((left, right) => left.time - right.time || left.timestamp.localeCompare(right.timestamp))
  const oldestActiveMatch = activeMatches[0]
  const nowTime = now.getTime()

  return {
    rule_count: rules.length,
    status_counts: statusCounts,
    cap,
    cap_relevant_count: capRelevantCount,
    cap_utilization: roundMetric(capRelevantCount / cap),
    confidence,
    hit_concentration_top_5: totalHits > 0 ? topFiveHits / totalHits : null,
    never_matched_count: rules.filter((rule) => rule.last_matched_at === null).length,
    oldest_active_last_matched_at: oldestActiveMatch?.timestamp ?? null,
    oldest_active_staleness_days:
      oldestActiveMatch && !Number.isNaN(nowTime)
        ? roundMetric(Math.max(0, nowTime - oldestActiveMatch.time) / DAY_MS)
        : null,
  }
}

function matchesCoarseBucket(signature: string, bucket: string): boolean {
  return signature === bucket || signature.startsWith(`${bucket}|`)
}

export function computeCostPerResolvedTask(
  episodes: Episode[],
  statsRecords: SessionStatsRecord[],
  bucket?: string,
): CostPerResolvedTask {
  const statsBySession = new Map<string, SessionStatsRecord>()
  for (const record of statsRecords) statsBySession.set(record.session_id, record)
  const authoritativeStats = [...statsBySession.values()]

  const episodeWeeks = new Map<string, { resolved: number; sessions: Set<string> }>()
  for (const episode of episodes) {
    if (bucket && !matchesCoarseBucket(episode.failure.signature, bucket)) continue
    const week = toIsoWeek(episode.timestamp)
    if (!week) continue
    const weekStats = episodeWeeks.get(week) ?? { resolved: 0, sessions: new Set<string>() }
    weekStats.sessions.add(episode.session_id)
    if (episode.outcome === 'resolved') weekStats.resolved += 1
    episodeWeeks.set(week, weekStats)
  }

  const allSessionWeeks = new Map<string, SessionStatsRecord[]>()
  for (const record of authoritativeStats) {
    const week = toIsoWeek(record.ts)
    if (!week) continue
    const weekRecords = allSessionWeeks.get(week) ?? []
    weekRecords.push(record)
    allSessionWeeks.set(week, weekRecords)
  }

  const weeks = new Set([...episodeWeeks.keys(), ...allSessionWeeks.keys()])
  return {
    unpriced_session_count: authoritativeStats.filter((record) => !record.priced).length,
    weekly: [...weeks]
      .sort((left, right) => left.localeCompare(right))
      .map((week) => {
        const episodeWeek = episodeWeeks.get(week)
        const episodeRows = [...(episodeWeek?.sessions ?? [])]
          .map((sessionId) => statsBySession.get(sessionId))
          .filter((record): record is SessionStatsRecord => record?.priced === true)
        const episodeCost =
          !episodeWeek || episodeRows.length === 0
            ? null
            : roundMetric(episodeRows.reduce((sum, record) => sum + record.cost_usd, 0))
        const resolved = episodeWeek?.resolved ?? 0
        const weekStats = allSessionWeeks.get(week) ?? []
        const pricedWeekStats = weekStats.filter((record) => record.priced)
        const allSessionsCost =
          pricedWeekStats.length === 0
            ? null
            : roundMetric(pricedWeekStats.reduce((sum, record) => sum + record.cost_usd, 0))

        return {
          week,
          resolved_episode_count: resolved,
          episode_bearing_session_cost_usd: episodeCost,
          unit_cost_usd:
            resolved > 0 && episodeCost !== null ? roundMetric(episodeCost / resolved) : null,
          all_sessions_cost_usd: allSessionsCost,
          unpriced_session_count: weekStats.filter((record) => !record.priced).length,
        }
      }),
  }
}

export function computeLedgerCoverage(
  journal: JournalReadResult,
  episodes: Episode[],
  calibrationRecords: CalibrationRecord[],
  stats: StatsReadResult,
): LedgerCoverage {
  const timestamps = journal.events
    .filter((event): event is JournalEvent & { ts: string } => typeof event.ts === 'string')
    .map((event) => ({ value: event.ts, time: new Date(event.ts).getTime() }))
    .filter(({ time }) => !Number.isNaN(time))
    .sort((left, right) => left.time - right.time || left.value.localeCompare(right.value))
  const sessions = new Set(
    journal.events
      .map((event) => event.session_id)
      .filter((sessionId): sessionId is string => typeof sessionId === 'string'),
  )

  return {
    journal_first_ts: timestamps[0]?.value ?? null,
    journal_last_ts: timestamps[timestamps.length - 1]?.value ?? null,
    distinct_session_count: sessions.size,
    journal_line_count: journal.line_count,
    episode_count: episodes.length,
    calibration_record_count: calibrationRecords.length,
    stats_row_count: stats.row_count,
  }
}
