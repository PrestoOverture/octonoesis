import type { QueryLoopContext, QueryState } from '../query/types'

export type HookEvent =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop'
  | 'session_start'
  | 'session_end'
  | 'compact'

/** Event payload data emitted during query lifecycle transitions and delivered to hooks. */
export interface HookPayload {
  event: HookEvent
  tool?: string
  input?: unknown
  outcome?: unknown
  sessionId?: string
}

/** Complete runtime context provided to a hook handler during execution. */
export interface HookContext {
  payload: HookPayload
  repoRoot: string
  abortSignal?: AbortSignal
  state?: QueryState & { system?: string }
  queryContext?: QueryLoopContext
}

/** Direct decision outcome returned by a hook handler. */
export interface HookResult {
  action?: 'allow' | 'deny'
  reason?: string
}

export type HookHandler =
  | { type: 'shell'; command: string }
  | { type: 'function'; fn: (ctx: HookContext) => Promise<HookResult | undefined> }

/** Registration rule mapping lifecycle events and tool filters to a hook handler. */
export interface HookMatcher {
  event: HookEvent
  toolPattern?: string
  timeoutMs?: number
  handler: HookHandler
}

export type HookExecutionOutcome = 'success' | 'failure' | 'timeout'

/** Detailed execution result of an individual hook invocation. */
export interface HookExecutionResult {
  outcome: HookExecutionOutcome
  denied: boolean
  reason?: string
}

/** Aggregate outcome summary from evaluating all matching hooks for an event. */
export interface HookRunSummary {
  denied: boolean
  reason?: string
  results: HookExecutionResult[]
}
