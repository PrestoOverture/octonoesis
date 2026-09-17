import type { CanonicalMessage, ContentBlock, Usage } from '../providers/types'

const MESSAGE_OVERHEAD_TOKENS = 4
const DEFAULT_CONTEXT_WINDOW = 128_000
const COMPACT_OUTPUT_RESERVE = 20_000
const COMPACT_SAFETY_MARGIN = 13_000

export interface ContextSnapshot {
  tokens: number
  coveredCount: number
}

/**
 * Estimates token usage using the repository-wide four-characters-per-token fallback.
 * @param text The input text string to estimate.
 * @returns Estimated number of tokens.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Estimates token usage for a single canonical content block (text, tool_use, or tool_result).
 * @param block The content block to evaluate.
 * @returns Estimated token count for the block.
 */
function estimateBlockTokens(block: ContentBlock): number {
  if (block.type === 'text') return estimateTextTokens(block.text)
  if (block.type === 'tool_use') {
    return estimateTextTokens(JSON.stringify(block.input) ?? '')
  }
  return estimateTextTokens(block.content)
}

/**
 * Estimates the serialized conversational payload plus a per-message framing overhead.
 * @param messages Array of canonical conversation messages.
 * @returns Total estimated token count.
 */
export function estimateMessagesTokens(messages: CanonicalMessage[]): number {
  return messages.reduce((total, message) => {
    const contentTokens =
      typeof message.content === 'string'
        ? estimateTextTokens(message.content)
        : message.content.reduce((sum, block) => sum + estimateBlockTokens(block), 0)
    return total + MESSAGE_OVERHEAD_TOKENS + contentTokens
  }, 0)
}

/**
 * Returns the total tokens consumed according to an API usage record, including cache tokens.
 * @param usage Provider usage report.
 * @returns The total sum of input, output, and cache creation/read tokens.
 */
export function totalTokensFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  )
}

/**
 * Calculates current context token usage, utilizing a known API usage snapshot as an anchor
 * and estimating only subsequent messages appended after the snapshot.
 * @param messages Current array of conversation messages.
 * @param snapshot Optional token snapshot from a prior API turn.
 * @returns Total estimated context tokens.
 */
export function contextTokensWithEstimation(
  messages: CanonicalMessage[],
  snapshot?: ContextSnapshot,
): number {
  if (!snapshot) return estimateMessagesTokens(messages)
  return snapshot.tokens + estimateMessagesTokens(messages.slice(snapshot.coveredCount))
}

/**
 * Resolves the maximum supported context window size in tokens for a given model identifier.
 * @param model The model identifier string.
 * @returns The context window size in tokens.
 */
export function getContextWindowSize(model: string): number {
  const normalizedModel = model.toLowerCase()
  if (normalizedModel.startsWith('claude-')) return 200_000
  if (normalizedModel.startsWith('gpt-5')) return 400_000
  if (normalizedModel.startsWith('gpt-4o')) return 128_000
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Returns the context size threshold in tokens at which automatic conversation compaction begins.
 * Respects OCTONOESIS_COMPACT_THRESHOLD environment variable override if set.
 * @param model The model identifier string.
 * @returns The compact threshold in tokens.
 */
export function getCompactThreshold(model: string): number {
  const override = process.env.OCTONOESIS_COMPACT_THRESHOLD
  if (override && /^\d+$/.test(override)) {
    const parsed = Number(override)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  return getContextWindowSize(model) - COMPACT_OUTPUT_RESERVE - COMPACT_SAFETY_MARGIN
}
