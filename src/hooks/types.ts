import type { QueryLoopContext, QueryState } from '../query/types'

export type HookEvent =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop'
  | 'session_start'
  | 'session_end'
  | 'compact'

export interface HookPayload {
  event: HookEvent
  tool?: string
  input?: unknown
  outcome?: unknown
  sessionId?: string
}

export interface HookContext {
  payload: HookPayload
  repoRoot: string
  abortSignal?: AbortSignal
  state?: QueryState & { system?: string }
  queryContext?: QueryLoopContext
}

export interface HookResult {
  action?: 'allow' | 'deny'
  reason?: string
}

export type HookHandler =
  | { type: 'shell'; command: string }
  | { type: 'function'; fn: (ctx: HookContext) => Promise<HookResult | undefined> }

export interface HookMatcher {
  event: HookEvent
  toolPattern?: string
  timeoutMs?: number
  handler: HookHandler
}

export type HookExecutionOutcome = 'success' | 'failure' | 'timeout'

export interface HookExecutionResult {
  outcome: HookExecutionOutcome
  denied: boolean
  reason?: string
}

export interface HookRunSummary {
  denied: boolean
  reason?: string
  results: HookExecutionResult[]
}
