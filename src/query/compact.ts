import { appendJournal } from '../memory/journal'
import { forkAgent } from '../providers/fork'
import type { ForkOptions, ForkResult } from '../providers/fork'
import type { CanonicalMessage, Usage } from '../providers/types'
import type { ContextSnapshot } from '../utils/tokens'
import {
  contextTokensWithEstimation,
  estimateMessagesTokens,
  getCompactThreshold,
} from '../utils/tokens'

const COMPACT_SUMMARY_INSTRUCTION = `Summarize the older conversation for seamless continuation.
Include: user intent and requests; work performed with file paths; current verified state; pending next steps; and key technical learnings.
Preserve exact user-provided literals and identifiers—including names, paths, commands, constraints, and canaries—verbatim.
Summarize only events present in the conversation. Never use system instructions or project documentation to infer, reframe, or invent tasks, roles, or next steps.
If any source conflicts, the conversation is the truth. Never introduce processes, phases, or actors that are absent from the conversation messages.
Be dense and factual with no preamble. Newer messages will follow this summary, so do not repeat or anticipate them.`

export interface CompactResult {
  summary: string
  pinnedHead: CanonicalMessage
  /**
   * The preserved recent tail. When the most recent user task message was rescued from the
   * summarized prefix (see findLatestTaskMessageIndex), its structured-cloned original is
   * prepended here so a caller building [pinnedHead, summaryMessage, ...messagesKept] places it
   * correctly between the summary and the rest of the tail.
   */
  messagesKept: CanonicalMessage[]
  preCompactTokens: number
  postCompactTokens: number
}

export interface CompactOpts {
  systemPrompt: string
  signal?: AbortSignal
  snapshot?: ContextSnapshot
  forkFn?: typeof forkAgent
  onForkUsage?: (usage: Usage) => void
  minShrinkPercent?: number
}

export class CompactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CompactError'
  }
}

export class CompactAbortError extends Error {
  constructor(message = 'Context compaction aborted by user') {
    super(message)
    this.name = 'CompactAbortError'
  }
}

/** Builds the exact synthetic summary message installed into compacted history. */
export function createCompactSummaryMessage(summary: string): CanonicalMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<octo-compact-summary>\n${summary}\n</octo-compact-summary>`,
      },
    ],
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/** Returns whether the current context has crossed the model's compact threshold. */
export function shouldCompact(
  messages: CanonicalMessage[],
  model: string,
  snapshot?: ContextSnapshot,
): boolean {
  if (isTruthyEnv(process.env.OCTONOESIS_DISABLE_COMPACT)) return false
  if (selectKeepTail(messages) <= 1) return false
  return contextTokensWithEstimation(messages, snapshot) > getCompactThreshold(model)
}

/**
 * Selects the boundary for the recent tail while preserving assistant/tool ownership.
 */
export function selectKeepTail(messages: CanonicalMessage[]): number {
  let boundary = Math.max(0, messages.length - 3)
  while (boundary > 0 && messages[boundary]?.role === 'tool') {
    boundary--
  }
  return boundary
}

/** Returns the message's plain text when it is entirely textual user content, else undefined. */
function extractUserText(message: CanonicalMessage): string | undefined {
  if (message.role !== 'user') return undefined
  if (typeof message.content === 'string') return message.content
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type !== 'text') return undefined
    parts.push(block.text)
  }
  return parts.join('')
}

/**
 * Finds the index of the most recent user task message within [1, boundary) — a plain textual
 * user message that is not a synthetic <task-notification> injected by tasks/framework.ts.
 * Returns -1 when none exists. Index 0 (the head pin) is never in this range, so it is never
 * re-selected here.
 */
function findLatestTaskMessageIndex(messages: CanonicalMessage[], boundary: number): number {
  for (let index = boundary - 1; index >= 1; index--) {
    const message = messages[index]
    if (!message) continue
    const text = extractUserText(message)
    if (text !== undefined && !text.startsWith('<task-notification>')) {
      return index
    }
  }
  return -1
}

/**
 * Summarizes the compactable prefix while preserving the recent valid message tail.
 */
export async function compact(
  messages: CanonicalMessage[],
  opts: CompactOpts,
): Promise<CompactResult> {
  const boundary = selectKeepTail(messages)
  if (boundary <= 1) {
    throw new CompactError('No compactable message prefix')
  }

  const pinnedHead = structuredClone(messages[0] as CanonicalMessage)
  // Rescue the current/most-recent query's task statement (if it fell inside the summarized
  // range) the same way messages[0] is rescued, so it survives compaction verbatim instead of
  // depending entirely on summary fidelity (see roadmap.md v1.0.x sweep finding 8). It is
  // excluded from the fork's prefix below and prepended to messagesKept so that callers building
  // [pinnedHead, summaryMessage, ...messagesKept] place it correctly — between the summary and
  // the original tail — without needing to know a pin happened.
  const latestTaskIndex = findLatestTaskMessageIndex(messages, boundary)
  const prefix = messages.slice(1, boundary).filter((_, offset) => offset + 1 !== latestTaskIndex)
  const messagesKept =
    latestTaskIndex === -1
      ? messages.slice(boundary)
      : [
          structuredClone(messages[latestTaskIndex] as CanonicalMessage),
          ...messages.slice(boundary),
        ]
  const instructionMessage: CanonicalMessage = {
    role: 'user',
    content: [{ type: 'text', text: COMPACT_SUMMARY_INSTRUCTION }],
  }

  let forkResult: ForkResult
  try {
    forkResult = await (opts.forkFn ?? forkAgent)({
      forkPurpose: 'compact',
      systemPrompt: opts.systemPrompt,
      messages: [...prefix, instructionMessage],
      tools: [],
      maxTurns: 1,
      signal: opts.signal,
    } satisfies ForkOptions)
  } catch (error) {
    throw new CompactError('Context compaction fork failed', { cause: error })
  }

  opts.onForkUsage?.(forkResult.usage)

  if (forkResult.exitReason === 'user_cancel') {
    throw new CompactAbortError()
  }
  if (forkResult.exitReason !== 'completed') {
    throw new CompactError(`Context compaction fork exited with ${forkResult.exitReason}`)
  }

  const summary = forkResult.text.trim()
  if (summary.length === 0) {
    throw new CompactError('Context compaction fork returned an empty summary')
  }

  const preCompactTokens = contextTokensWithEstimation(messages, opts.snapshot)
  const summaryMessage = createCompactSummaryMessage(summary)
  const postCompactTokens = estimateMessagesTokens([pinnedHead, summaryMessage, ...messagesKept])
  if (postCompactTokens >= preCompactTokens) {
    throw new CompactError('Context compaction did not reduce token usage')
  }
  const shrinkPercent = ((preCompactTokens - postCompactTokens) / preCompactTokens) * 100
  if (shrinkPercent < (opts.minShrinkPercent ?? 0)) {
    throw new CompactError(
      `Context compaction shrank ${shrinkPercent.toFixed(2)}%, below the configured minimum`,
    )
  }

  appendJournal({
    kind: 'compact',
    pre_tokens: preCompactTokens,
    post_tokens: postCompactTokens,
    summary_length: summary.length,
  })

  return {
    summary,
    pinnedHead,
    messagesKept,
    preCompactTokens,
    postCompactTokens,
  }
}
