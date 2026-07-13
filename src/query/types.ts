import type { OctonoesisConfig } from '../config/schema'
import type { HookRegistry } from '../hooks/registry'
import type { McpClientConnection } from '../mcp/types'
import type { Fingerprint } from '../memory/fingerprint/extract'
import type { RuleFile } from '../memory/rules/types'
import type { VerifyResult } from '../memory/verifier'
import type { CanonicalMessage, Usage } from '../providers/types'

export type { CanonicalMessage, Usage }

export type ExitReason =
  | 'completed'
  | 'max_turns'
  | 'fatal_error'
  | 'user_cancel'
  | 'budget_exceeded'
  | 'prompt_too_long'

export interface InjectedRule {
  rule: RuleFile
  fingerprint: Fingerprint
}

export interface VerifyResultWithRun extends VerifyResult {
  isVerificationRun: boolean
}

export interface QueryInternalState {
  _lastVerifyResult?: VerifyResultWithRun
  _lastVerifyResultForQuery?: VerifyResultWithRun
  _lastFingerprints?: Fingerprint[]
  firstTurnDynamicSystem?: string
}

export interface SessionState {
  sessionId: string
  startTime: number
  turns: number
  usage: Usage
  costUsd: number
  contextUtilization: number
  compactCount: number
  model: string
}

export type { HookRegistry } from '../hooks/registry'

export interface TaskState {
  id: string
  type: 'shell' | 'agent'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed'
  startTime: number
  command?: string
  endTime?: number
  output?: string
  error?: string
  usage?: Usage
}

export interface SandboxConfig {
  enabled: boolean
  filesystem?: {
    allowWrite?: string[]
    denyRead?: string[]
  }
  network?: {
    allowedDomains?: string[]
  }
}

export interface QueryToolContextFields {
  repoRoot: string
  /** Optional cumulative billed-token cap for the query session. */
  tokenBudget?: number
  abortSignal?: AbortSignal
  messages?: CanonicalMessage[]
  sessionId?: string
  sessionState?: SessionState
  sandbox?: SandboxConfig
  hooks?: HookRegistry
  config?: OctonoesisConfig
  tasks?: Map<string, TaskState>
  mcpConnections?: Map<string, McpClientConnection>
  injectedRules?: InjectedRule[]
  recordedRuleOutcomes?: Set<string>
  verificationCommand?: string
}

export interface QueryState {
  turn: number
  messages: CanonicalMessage[]
  usage: Usage
  model: string
  sessionId: string
  abortSignal?: AbortSignal
  repoRoot: string
  compactBoundary?: number
  /** Initialized concretely by the engine; optional here for Batch 0 construction compatibility. */
  compactConsecutiveFailures?: number
  compactCircuitOpen?: boolean
  lastCompactTurn?: number
  injectedRules: InjectedRule[]
  recordedRuleOutcomes: Set<string>
  tasks: Map<string, TaskState>
  hooks: HookRegistry
}

export interface QueryResultV1 {
  exit_reason: ExitReason
  usage: Usage
  turns: number
  final_message?: string
  error?: string
}

export type QueryLoopContext = QueryToolContextFields & QueryInternalState
