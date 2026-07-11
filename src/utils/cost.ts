import type { Usage } from '../providers/types'

export interface ModelPricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

// User-adjustable pricing data in USD per one million tokens; estimation logic lives below.
const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-haiku-4-5': { input: 0.8, output: 4 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
}

const PRICING_PREFIXES = Object.keys(MODEL_PRICING).sort(
  (left, right) => right.length - left.length,
)

export function estimateCost(usage: Usage, model: string): { costUsd: number; priced: boolean } {
  const normalizedModel = model.toLowerCase()
  const prefix = PRICING_PREFIXES.find((candidate) => normalizedModel.startsWith(candidate))
  if (!prefix) return { costUsd: 0, priced: false }

  const pricing = MODEL_PRICING[prefix]
  if (!pricing) return { costUsd: 0, priced: false }
  const cacheRead = pricing.cacheRead ?? pricing.input * 0.1
  const cacheWrite = pricing.cacheWrite ?? pricing.input * 1.25
  return {
    costUsd:
      (usage.input_tokens * pricing.input +
        usage.output_tokens * pricing.output +
        (usage.cache_read_input_tokens ?? 0) * cacheRead +
        (usage.cache_creation_input_tokens ?? 0) * cacheWrite) /
      1_000_000,
    priced: true,
  }
}
