import { RULE_STATUSES } from './metrics.ts'
import type { FitnessDashboard } from './schema.ts'

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function decimal(value: number | null, digits = 3): string {
  return value === null ? 'n/a' : value.toFixed(digits)
}

function money(value: number | null): string {
  return value === null ? 'n/a' : `$${value.toFixed(4)}`
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const renderRow = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join('  ')
      .trimEnd()
  return [
    renderRow(headers),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(renderRow),
  ].join('\n')
}

function statusSummary(counts: FitnessDashboard['rule_pool_health']['status_counts']): string {
  return RULE_STATUSES.filter((status) => counts[status] > 0)
    .map((status) => `${status}:${counts[status]}`)
    .join(', ')
}

export function formatFitnessDashboard(report: FitnessDashboard): string {
  const lines = [
    'Octonoesis Fitness Dashboard',
    `As of ${report.as_of} | Window: ${report.filters.weeks ? `${report.filters.weeks} ISO week(s)` : 'all data'} | Cost bucket: ${report.filters.bucket ?? 'all'}`,
    '',
    '1. Ledger coverage',
  ]

  const coverage = report.ledger_coverage
  if (
    coverage.journal_line_count === 0 &&
    coverage.episode_count === 0 &&
    coverage.calibration_record_count === 0 &&
    coverage.stats_row_count === 0
  ) {
    lines.push('insufficient data — no ledger records found')
  } else {
    lines.push(
      `Journal span: ${coverage.journal_first_ts ?? 'n/a'} -> ${coverage.journal_last_ts ?? 'n/a'}`,
      `Sessions: ${coverage.distinct_session_count} | journal lines: ${coverage.journal_line_count} | episodes: ${coverage.episode_count} | calibration: ${coverage.calibration_record_count} | stats rows: ${coverage.stats_row_count}`,
    )
  }

  lines.push('', '2. Rule hit-rate by prompt hash')
  if (report.rule_hit_rate_by_prompt_hash.length === 0) {
    lines.push('insufficient data — no rules found')
  } else {
    lines.push(
      table(
        ['Prompt hash', 'Rules', 'Status', 'Hits/Misses', 'Hit rate (n)', 'Posterior', '95% CI'],
        report.rule_hit_rate_by_prompt_hash.map((group) => [
          group.prompt_hash,
          String(group.rule_count),
          statusSummary(group.status_counts),
          `${group.hits}/${group.misses}`,
          group.n === 0 ? 'no accounting yet' : `${percent(group.hit_rate)} (${group.n})`,
          percent(group.posterior_mean),
          `[${percent(group.credible_interval[0])}, ${percent(group.credible_interval[1])}]`,
        ]),
      ),
    )
  }

  lines.push('', '3. Calibration trend')
  if (report.calibration_trend.weekly.length === 0) {
    lines.push('insufficient data — no calibration outcomes found')
  } else {
    lines.push(
      `Overall walk-forward Brier: ${decimal(report.calibration_trend.overall_brier)} (lower is better)`,
      table(
        ['ISO week', 'Records', 'Brier ↓', 'First-attempt success ↑'],
        report.calibration_trend.weekly.map((week) => [
          week.week,
          String(week.records),
          decimal(week.brier),
          `${week.successes}/${week.records} (${percent(week.first_attempt_success_rate)})`,
        ]),
      ),
    )
  }

  lines.push('', '4. Repeat-failure rate trend')
  if (report.repeat_failure_rate_trend.length === 0) {
    lines.push('insufficient data — no fingerprint occurrences found')
  } else {
    lines.push(
      'Lower is better; an occurrence repeats an earlier resolved failure from another session.',
      table(
        ['ISO week', 'Occurrences', 'Repeats', 'Repeat rate ↓'],
        report.repeat_failure_rate_trend.map((week) => [
          week.week,
          String(week.occurrences),
          String(week.repeats),
          percent(week.repeat_failure_rate),
        ]),
      ),
    )
  }

  lines.push('', '5. Rule-pool health')
  const pool = report.rule_pool_health
  if (pool.rule_count === 0) {
    lines.push('insufficient data — no rules found')
  } else {
    lines.push(
      `Rules: ${pool.rule_count} (${statusSummary(pool.status_counts)})`,
      `Cap: ${pool.cap_relevant_count}/${pool.cap} (${percent(pool.cap_utilization)}) active + candidate`,
      pool.confidence
        ? `Confidence (non-banned): min ${decimal(pool.confidence.min)} | median ${decimal(pool.confidence.median)} | mean ${decimal(pool.confidence.mean)} | max ${decimal(pool.confidence.max)}`
        : 'Confidence: n/a',
      `Top-5 hit concentration: ${percent(pool.hit_concentration_top_5)} | never matched: ${pool.never_matched_count}`,
      `Oldest active match: ${pool.oldest_active_last_matched_at ?? 'n/a'} | staleness: ${pool.oldest_active_staleness_days === null ? 'n/a' : `${decimal(pool.oldest_active_staleness_days, 1)} days`}`,
    )
  }

  lines.push('', '6. Cost per resolved task')
  const cost = report.cost_per_resolved_task
  if (cost.weekly.length === 0) {
    lines.push('insufficient data — no episode or session-cost records found')
  } else {
    lines.push(
      `Unpriced authoritative sessions excluded from sums: ${cost.unpriced_session_count}`,
      table(
        ['ISO week', 'Resolved', 'Episode cost', 'Unit cost', 'All-session cost', 'Unpriced'],
        cost.weekly.map((week) => [
          week.week,
          String(week.resolved_episode_count),
          money(week.episode_bearing_session_cost_usd),
          money(week.unit_cost_usd),
          money(week.all_sessions_cost_usd),
          String(week.unpriced_session_count),
        ]),
      ),
    )
  }

  return lines.join('\n')
}
