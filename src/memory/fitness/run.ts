import { getMemoryDir } from '../../utils/path.ts'
import { buildFitnessDashboard, formatFitnessJson } from './dashboard.ts'
import { formatFitnessDashboard } from './format.ts'
import { loadFitnessInput } from './io.ts'

export interface RenderFitnessDashboardOptions {
  memoryDir?: string
  now?: Date
  json?: boolean
  weeks?: number
  bucket?: string
}

export async function renderFitnessDashboard(
  options: RenderFitnessDashboardOptions = {},
): Promise<string> {
  const input = await loadFitnessInput(options.memoryDir ?? getMemoryDir())
  const report = buildFitnessDashboard(input, {
    now: options.now ?? new Date(),
    ...(options.weeks === undefined ? {} : { weeks: options.weeks }),
    ...(options.bucket === undefined ? {} : { bucket: options.bucket }),
  })
  return options.json ? formatFitnessJson(report) : formatFitnessDashboard(report)
}
