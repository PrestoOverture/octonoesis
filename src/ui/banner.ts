import { version } from '../../package.json'
import { type FitnessInput, buildFitnessDashboard } from '../memory/fitness/dashboard'
import { toIsoWeek } from '../memory/fitness/metrics'
export { version }

export function fitnessLines(input: FitnessInput, now = new Date()): string[] {
  const report = buildFitnessDashboard(input, { now })
  const active = report.rule_pool_health.status_counts.active
  const episodes = input.episodes.length
  const lines = active || episodes ? [`${active} active rules · ${episodes} episodes`] : []
  const weekly = report.calibration_trend.weekly
  const current = weekly.find((week) => week.week === toIsoWeek(now.toISOString()))
  const previous = weekly.find(
    (week) => week.week === toIsoWeek(new Date(+now - 604800000).toISOString()),
  )
  if (current && previous && current.records >= 10 && previous.records >= 10) {
    lines.push(
      `First try: ${Math.round(current.first_attempt_success_rate * 100)}% this wk / ${Math.round(previous.first_attempt_success_rate * 100)}% last wk`,
    )
  }
  return lines
}

export function bannerLines(model: string, repo: string, fitness: string[] = []): string[] {
  return [
    `Noe · Octonoesis v${version}`,
    'A coding agent that learns your repo.',
    `Model: ${model}`,
    `Repo: ${repo}`,
    ...fitness,
    'Tips: /stats · Enter sends · ctrl+c stops',
  ]
}

export function bannerLayout(columns: number, rows: number, lineCount: number, color: boolean) {
  const layout = columns >= 76 ? 'beside' : 'above'
  const height = layout === 'beside' ? Math.max(17, lineCount) : 17 + lineCount
  return color && columns >= 60 && height + 9 <= rows - 1 ? layout : 'text'
}
