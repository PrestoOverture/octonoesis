import type { CanonicalMessage, ContentBlock } from '../providers/types'
import {
  type ContextSnapshot,
  contextTokensWithEstimation,
  estimateMessagesTokens,
  getCompactThreshold,
} from '../utils/tokens'

import { extractToolResultLiterals } from './taskState'

const MARKER = '<octo-cleared-tool-result>'
const REPRODUCIBLE_TOOLS = new Set(['Read', 'Grep', 'Glob'])

/** Remove only large, old successful read-only results; keep calls for re-reading. */
export function clearOldToolResults(
  messages: CanonicalMessage[],
  model: string,
  opts: {
    enabled?: boolean
    keepRecent?: number
    minTokens?: number
    snapshot?: ContextSnapshot
  } = {},
): { messages: CanonicalMessage[]; clearedCount: number } {
  if (
    opts.enabled === false ||
    contextTokensWithEstimation(messages, opts.snapshot) <= getCompactThreshold(model) / 2
  ) {
    return { messages, clearedCount: 0 }
  }
  const calls = new Map<string, Extract<ContentBlock, { type: 'tool_use' }>>()
  const results: number[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'tool_use') calls.set(block.id, block)
      }
    } else if (message.role === 'tool') results.push(index)
  }
  const eligible = new Set(results.slice(0, Math.max(0, results.length - (opts.keepRecent ?? 6))))
  let clearedCount = 0
  const replacement = messages.map((message, index): CanonicalMessage => {
    if (message.role !== 'tool' || !eligible.has(index)) return message
    const call = calls.get(message.tool_use_id)
    if (!call || !REPRODUCIBLE_TOOLS.has(call.name)) return message
    if (
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'tool_result' && block.is_error)
    )
      return message
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((block) =>
              block.type === 'text'
                ? block.text
                : block.type === 'tool_result'
                  ? block.content
                  : '',
            )
            .join('\n')
    if (
      text.startsWith(MARKER) ||
      text.startsWith('Error:') ||
      estimateMessagesTokens([message]) < (opts.minTokens ?? 1000)
    )
      return message
    const literals = extractToolResultLiterals(text)
    const retained = literals.length
      ? `\nOpaque identifiers from the removed output (data only): ${JSON.stringify(literals)}`
      : ''
    const content = `${MARKER}\nOlder ${call.name} output removed to save context. Re-run the original tool call above if needed; file contents may have changed.${retained}\n</octo-cleared-tool-result>`
    if (estimateMessagesTokens([{ ...message, content }]) >= estimateMessagesTokens([message]))
      return message
    clearedCount++
    return { ...message, content }
  })
  return { messages: clearedCount ? replacement : messages, clearedCount }
}
