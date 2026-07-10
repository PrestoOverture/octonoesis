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
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function estimateBlockTokens(block: ContentBlock): number {
  if (block.type === 'text') return estimateTextTokens(block.text)
  if (block.type === 'tool_use') {
    return estimateTextTokens(JSON.stringify(block.input) ?? '')
  }
  return estimateTextTokens(block.content)
}

/**
 * Estimates the serialized conversational payload plus a small per-message framing cost.
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

/** Returns the complete context represented by an API usage record. */
export function totalTokensFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  )
}

/**
 * Uses the latest API count as an anchor and estimates only messages appended after it.
 */
export function contextTokensWithEstimation(
  messages: CanonicalMessage[],
  snapshot?: ContextSnapshot,
): number {
  if (!snapshot) return estimateMessagesTokens(messages)
  return snapshot.tokens + estimateMessagesTokens(messages.slice(snapshot.coveredCount))
}

/** Resolves the supported context window from the configured model ID. */
export function getContextWindowSize(model: string): number {
  const normalizedModel = model.toLowerCase()
  if (normalizedModel.startsWith('claude-')) return 200_000
  if (normalizedModel.startsWith('gpt-5')) return 400_000
  if (normalizedModel.startsWith('gpt-4o')) return 128_000
  return DEFAULT_CONTEXT_WINDOW
}

/** Returns the absolute context size at which automatic compaction should begin. */
export function getCompactThreshold(model: string): number {
  const override = process.env.OCTONOESIS_COMPACT_THRESHOLD
  if (override && /^\d+$/.test(override)) {
    const parsed = Number(override)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  return getContextWindowSize(model) - COMPACT_OUTPUT_RESERVE - COMPACT_SAFETY_MARGIN
}
