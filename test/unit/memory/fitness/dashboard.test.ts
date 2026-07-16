import { describe, expect, it } from 'bun:test'
import {
  buildFitnessDashboard,
  formatFitnessJson,
} from '../../../../src/memory/fitness/dashboard.ts'
import { formatFitnessDashboard } from '../../../../src/memory/fitness/format.ts'
import { fitnessDashboardSchema } from '../../../../src/memory/fitness/schema.ts'

const emptyInput = {
  journal: { line_count: 0, events: [] },
  episodes: [],
  rules: [],
  calibration_records: [],
  stats: { row_count: 0, records: [] },
}

describe('fitness dashboard report', () => {
  it('emits schema-versioned deterministic JSON and honest empty text', () => {
    const now = new Date('2026-07-01T00:00:00.000Z')
    const first = buildFitnessDashboard(emptyInput, { now })
    const second = buildFitnessDashboard(emptyInput, { now })

    expect(fitnessDashboardSchema.parse(first)).toEqual(first)
    expect(formatFitnessJson(first)).toBe(formatFitnessJson(second))
    expect(JSON.parse(formatFitnessJson(first)).schema_version).toBe(1)

    const text = formatFitnessDashboard(first)
    expect(text).toContain('1. Ledger coverage')
    expect(text).toContain('2. Rule hit-rate by prompt hash')
    expect(text).toContain('3. Calibration trend')
    expect(text).toContain('4. Repeat-failure rate trend')
    expect(text).toContain('5. Rule-pool health')
    expect(text).toContain('6. Cost per resolved task')
    expect(text.match(/insufficient data/g)?.length).toBe(6)
  })

  it('renders non-empty table rows in aligned columns instead of array commas', () => {
    const report = buildFitnessDashboard(emptyInput, {
      now: new Date('2026-07-01T00:00:00.000Z'),
    })
    report.calibration_trend = {
      group_count: 1,
      overall_brier: 0.25,
      weekly: [
        {
          week: '2026-W23',
          records: 2,
          brier: 0.25,
          successes: 1,
          first_attempt_success_rate: 0.5,
        },
      ],
    }

    const text = formatFitnessDashboard(report)

    expect(text).toContain('2026-W23  2        0.250')
    expect(text).not.toContain('2026-W23,2,0.250')
  })
})
