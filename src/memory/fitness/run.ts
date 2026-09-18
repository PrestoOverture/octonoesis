import { getMemoryDir } from '../../utils/path.ts'
import { buildFitnessDashboard, formatFitnessJson } from './dashboard.ts'
import { formatFitnessDashboard } from './format.ts'
import { loadFitnessInput } from './io.ts'

/**
 * Options for rendering the memory fitness dashboard.
 */
export interface RenderFitnessDashboardOptions {
  memoryDir?: string
  now?: Date
  json?: boolean
  weeks?: number
  bucket?: string
}

/**
 * Loads fitness input data, compiles the fitness dashboard report, and formats it as text or JSON.
 *
 * @param options - Configuration options including memory directory, reference date, filters, and JSON flag
 * @returns Formatted fitness dashboard as either human-readable text or serialized JSON
 * @throws If file reading fails or invalid options (such as non-positive weeks) are provided
 */
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
