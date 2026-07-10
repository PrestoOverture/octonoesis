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
Be dense and factual with no preamble. Newer messages will follow this summary, so do not repeat or anticipate them.`

export interface CompactResult {
  summary: string
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

/** Builds the exact synthetic message installed into history after compaction. */
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

/**
 * Summarizes the compactable prefix while preserving the recent valid message tail.
 */
export async function compact(
  messages: CanonicalMessage[],
  opts: CompactOpts,
): Promise<CompactResult> {
  const boundary = selectKeepTail(messages)
  if (boundary === 0) {
    throw new CompactError('No compactable message prefix')
  }

  const prefix = messages.slice(0, boundary)
  const messagesKept = messages.slice(boundary)
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
  const postCompactTokens = estimateMessagesTokens([
    createCompactSummaryMessage(summary),
    ...messagesKept,
  ])
  if (postCompactTokens >= preCompactTokens) {
    throw new CompactError('Context compaction did not reduce token usage')
  }

  appendJournal({
    kind: 'compact',
    pre_tokens: preCompactTokens,
    post_tokens: postCompactTokens,
    summary_length: summary.length,
  })

  return {
    summary,
    messagesKept,
    preCompactTokens,
    postCompactTokens,
  }
}
