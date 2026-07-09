import { describe, expect, it } from 'bun:test'
import type {
  ExitReason,
  HookRegistry,
  McpConnection,
  QueryLoopContext,
  QueryResultV1,
  QueryState,
  SandboxConfig,
  SessionState,
  TaskState,
  VerifyResultWithRun,
} from '../../../src/query/types'
import type { ToolContext } from '../../../src/tools/Tool'

const assertToolContext = (ctx: ToolContext): ToolContext => ctx
const assertQueryLoopContext = (ctx: QueryLoopContext): QueryLoopContext => ctx

function describeExit(reason: ExitReason): string {
  switch (reason) {
    case 'completed':
      return 'completed'
    case 'max_turns':
      return 'max_turns'
    case 'fatal_error':
      return 'fatal_error'
    case 'user_cancel':
      return 'user_cancel'
    case 'budget_exceeded':
      return 'budget_exceeded'
    case 'prompt_too_long':
      return 'prompt_too_long'
  }

  const exhaustive: never = reason
  return exhaustive
}

describe('query v1 type contracts', () => {
  it('keeps minimal ToolContext construction backward-compatible', () => {
    const ctx = assertToolContext({ repoRoot: '/tmp' })

    expect(ctx.repoRoot).toBe('/tmp')
  })

  it('allows ToolContext construction with all optional v1 fields', async () => {
    const sessionState: SessionState = {
      sessionId: 'session-1',
      startTime: 1,
      turns: 2,
      usage: { input_tokens: 3, output_tokens: 4 },
      costUsd: 0.01,
      contextUtilization: 0.5,
      compactCount: 1,
      model: 'test-model',
    }
    const hooks: HookRegistry = {}
    const task: TaskState = {
      id: 'task-1',
      type: 'shell',
      status: 'pending',
      startTime: 1,
    }
    const mcpConnection: McpConnection = {
      name: 'sqlite',
      status: 'connected',
      cleanup: async () => {},
    }
    const sandbox: SandboxConfig = {
      enabled: true,
      filesystem: { allowWrite: ['/tmp'], denyRead: ['~/.ssh'] },
      network: { allowedDomains: ['example.com'] },
    }
    const ctx = assertToolContext({
      repoRoot: '/repo',
      abortSignal: new AbortController().signal,
      messages: [{ role: 'user', content: 'hello' }],
      sessionId: 'session-1',
      sessionState,
      sandbox,
      hooks,
      tasks: new Map([[task.id, task]]),
      mcpConnections: new Map([[mcpConnection.name, mcpConnection]]),
      injectedRules: [],
      recordedRuleOutcomes: new Set<string>(),
      verificationCommand: 'bun test',
    })

    await mcpConnection.cleanup()
    expect(ctx.sessionState?.model).toBe('test-model')
    expect(ctx.tasks?.get('task-1')?.status).toBe('pending')
  })

  it('allows full QueryState construction', () => {
    const state: QueryState = {
      turn: 1,
      messages: [{ role: 'user', content: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'test-model',
      sessionId: 'session-1',
      abortSignal: new AbortController().signal,
      repoRoot: '/repo',
      compactBoundary: 0,
      injectedRules: [],
      recordedRuleOutcomes: new Set<string>(),
      tasks: new Map<string, TaskState>(),
      hooks: {},
    }

    expect(state.turn).toBe(1)
    expect(state.injectedRules.length).toBe(0)
  })

  it('keeps ExitReason exhaustive over all six variants', () => {
    const reasons: ExitReason[] = [
      'completed',
      'max_turns',
      'fatal_error',
      'user_cancel',
      'budget_exceeded',
      'prompt_too_long',
    ]

    expect(reasons.map(describeExit)).toEqual(reasons)
  })

  it('allows QueryLoopContext to accept public context and internal fields', () => {
    const minimal = assertQueryLoopContext({ repoRoot: '/repo' })
    const verifyResult: VerifyResultWithRun = {
      verdict: 'PASS',
      fingerprints: [],
      command: 'bun test',
      exit_code: 0,
      stale: false,
      isVerificationRun: true,
    }
    const full = assertQueryLoopContext({
      repoRoot: '/repo',
      _lastVerifyResult: verifyResult,
      _lastVerifyResultForQuery: verifyResult,
      _lastFingerprints: [],
      firstTurnDynamicSystem: 'dynamic',
    })

    expect(minimal.repoRoot).toBe('/repo')
    expect(full._lastVerifyResult?.isVerificationRun).toBe(true)
  })

  it('exports forward-looking result and placeholder types', () => {
    const result: QueryResultV1 = {
      exit_reason: 'budget_exceeded',
      usage: { input_tokens: 1, output_tokens: 2 },
      turns: 3,
    }
    const task: TaskState = {
      id: 'task-1',
      type: 'agent',
      status: 'completed',
      startTime: 1,
    }
    const sandbox: SandboxConfig = { enabled: false }
    const mcp: McpConnection = {
      name: 'server',
      status: 'closed',
      cleanup: async () => {},
    }

    expect(result.exit_reason).toBe('budget_exceeded')
    expect(task.type).toBe('agent')
    expect(sandbox.enabled).toBe(false)
    expect(mcp.status).toBe('closed')
  })
})
