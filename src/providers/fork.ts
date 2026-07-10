import type { ExitReason } from '../query/types'
import type { CanonicalMessage, CanonicalTool, Usage } from './types'

export type ForkPurpose = 'compact' | 'memory_extract' | 'memory_recall' | 'skill' | 'tool_summary'

export interface ForkOptions {
  systemPrompt: string
  messages: CanonicalMessage[]
  tools: CanonicalTool[]
  model: string
  maxTurns?: number
  maxTokens?: number
  signal?: AbortSignal
  forkPurpose: ForkPurpose
}

export interface ForkResult {
  text: string
  usage: Usage
  turns: number
  exitReason: ExitReason
}

export interface PreparedFork {
  systemPrompt: string
  messages: CanonicalMessage[]
  tools: CanonicalTool[]
  childEnv: Record<string, string>
  budget: {
    maxTurns: number
    maxTokens?: number
  }
  purpose: ForkPurpose
  model: string
}

export const FORK_TOOL_ALLOWLISTS: Record<Exclude<ForkPurpose, 'skill'>, readonly string[]> = {
  compact: [],
  memory_extract: ['Read', 'Grep', 'Glob', 'Write'],
  memory_recall: [],
  tool_summary: [],
}

export const MEMORY_EXTRACT_WRITE_SCOPE = '.octonoesis/memory/'

const AGENT_TOOL_NAMES = new Set(['Agent', 'AgentTool'])

export class ForkInvariantError extends Error {
  readonly reason: 'recursion_depth' | 'tool_not_allowed'

  constructor(reason: 'recursion_depth' | 'tool_not_allowed') {
    super(`Fork invariant violated: ${reason}`)
    this.name = 'ForkInvariantError'
    this.reason = reason
  }
}

export function getForkDepth(env: Record<string, string | undefined> = process.env): number {
  const depth = Number(env.OCTONOESIS_FORK_DEPTH)
  return Number.isInteger(depth) && depth > 0 ? depth : 0
}

export function prepareForkInput(opts: ForkOptions): PreparedFork {
  const depth = getForkDepth()
  if (depth >= 1) {
    throw new ForkInvariantError('recursion_depth')
  }

  const allowedTools =
    opts.forkPurpose === 'skill' ? undefined : FORK_TOOL_ALLOWLISTS[opts.forkPurpose]
  const hasDisallowedTool = opts.tools.some(
    (tool) =>
      AGENT_TOOL_NAMES.has(tool.name) ||
      (allowedTools !== undefined && !allowedTools.includes(tool.name)),
  )
  if (hasDisallowedTool) {
    throw new ForkInvariantError('tool_not_allowed')
  }

  const maxTurns = opts.maxTurns ?? 3
  if (!(maxTurns >= 1)) {
    throw new RangeError('Fork maxTurns must be at least 1')
  }

  return {
    systemPrompt: opts.systemPrompt,
    messages: structuredClone(opts.messages),
    tools: opts.tools,
    childEnv: { OCTONOESIS_FORK_DEPTH: String(depth + 1) },
    budget: {
      maxTurns,
      ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
    },
    purpose: opts.forkPurpose,
    model: opts.model,
  }
}

export async function forkAgent(opts: ForkOptions): Promise<ForkResult> {
  prepareForkInput(opts)

  return {
    text: '',
    usage: { input_tokens: 0, output_tokens: 0 },
    turns: 0,
    exitReason: 'completed',
  }
}
