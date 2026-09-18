// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the runtime.
declare const Bun: any

import { appendJournal } from '../memory/journal'
import { dbg } from '../utils/debug'
import type { HookRegistry } from './registry'
import type {
  HookContext,
  HookExecutionOutcome,
  HookExecutionResult,
  HookPayload,
  HookRunSummary,
} from './types'

export const HOOK_TIMEOUT_MS = 5_000
const HOOK_TERM_GRACE_MS = 250

/** Timing and timeout configuration options for hook execution. */
export interface ExecuteHooksOptions {
  timeoutMs?: number
  termGraceMs?: number
}

type HookRuntimeContext = Omit<HookContext, 'payload'>

/**
 * Computes elapsed execution duration in milliseconds from a high-resolution start timestamp.
 *
 * @param started - Start timestamp from `performance.now()`.
 * @returns Elapsed duration in non-negative rounded milliseconds.
 */
function hookDuration(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

/**
 * Appends a hook execution event to the memory journal ledger.
 *
 * @param payload - The payload associated with the hook trigger event.
 * @param type - Execution handler type (`'shell'` or `'function'`).
 * @param started - Start timestamp from `performance.now()`.
 * @param outcome - Result outcome of the hook run (`'success'`, `'failure'`, or `'timeout'`).
 */
function journalHook(
  payload: HookPayload,
  type: 'shell' | 'function',
  started: number,
  outcome: HookExecutionOutcome,
): void {
  appendJournal({
    kind: 'hook',
    hook_event: payload.event,
    hook_type: type,
    duration_ms: hookDuration(started),
    outcome,
  })
}

/**
 * Sends a signal to the process group of a spawned hook process, falling back to direct process signal.
 *
 * @param proc - Process handle with PID and kill method.
 * @param signal - OS signal to transmit (e.g. SIGTERM or SIGKILL).
 */
function killProcessGroup(
  proc: { pid: number; kill(signal?: NodeJS.Signals): void },
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {}
  }
}

/**
 * Executes a shell hook command in a detached shell process, piping JSON payload over stdin and enforcing timeouts.
 *
 * @param command - Shell command string to execute.
 * @param payload - Hook event payload serialized to stdin.
 * @param runtime - Runtime context containing repository root.
 * @param options - Execution options containing timeout and grace period in milliseconds.
 * @returns Promise resolving to the hook execution result.
 */
async function runShell(
  command: string,
  payload: HookPayload,
  runtime: HookRuntimeContext,
  options: Required<ExecuteHooksOptions>,
): Promise<HookExecutionResult> {
  const proc = Bun.spawn({
    cmd: ['/bin/sh', '-c', command],
    cwd: runtime.repoRoot,
    env: { ...process.env, OCTONOESIS_HOOK_EVENT: payload.event },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  proc.stdin.write(JSON.stringify(payload))
  await proc.stdin.end()
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()

  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    proc.exited.then(() => false),
    new Promise<true>((resolve) => {
      timeout = setTimeout(() => resolve(true), options.timeoutMs)
    }),
  ])
  if (timeout) clearTimeout(timeout)

  if (timedOut) {
    killProcessGroup(proc, 'SIGTERM')
    let grace: ReturnType<typeof setTimeout> | undefined
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<false>((resolve) => {
        grace = setTimeout(() => resolve(false), options.termGraceMs)
      }),
    ])
    if (grace) clearTimeout(grace)
    if (!exited) killProcessGroup(proc, 'SIGKILL')
    await proc.exited
    await Promise.allSettled([stdout, stderr])
    return { outcome: 'timeout', denied: false }
  }

  const [exitCode, stderrText] = await Promise.all([proc.exited, stderr])
  await stdout
  if (payload.event === 'pre_tool_use' && exitCode === 2) {
    return {
      outcome: 'failure',
      denied: true,
      reason: stderrText.trim() || 'Blocked by pre_tool_use hook',
    }
  }
  return { outcome: exitCode === 0 ? 'success' : 'failure', denied: false }
}

/**
 * Wraps a promise in a timeout guard, returning either the resolved value or a timed-out indicator.
 *
 * @param operation - The asynchronous operation promise to race.
 * @param timeoutMs - Maximum execution duration in milliseconds before timing out.
 * @param onTimeout - Optional callback triggered if the timeout fires before resolution.
 * @returns Object indicating whether the operation timed out and containing the value on success.
 */
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    operation.then((value) => ({ timedOut: false as const, value })),
    new Promise<{ timedOut: true }>((resolve) => {
      timeout = setTimeout(() => {
        onTimeout?.()
        resolve({ timedOut: true })
      }, timeoutMs)
    }),
  ])
  if (timeout) clearTimeout(timeout)
  return result
}

/**
 * Matches and executes all registered hooks for a given event, logging outcomes to the memory journal.
 * Evaluates both shell-based and TypeScript function handlers, observing timeout limits and denial responses.
 *
 * @param registry - Hook registry containing registered matchers.
 * @param payload - Event details including event name, optional tool, inputs, and outcomes.
 * @param runtime - Execution context containing repository root and abort signals.
 * @param options - Execution timeout and termination grace options.
 * @returns Summary of all executed hooks including whether any hook denied execution.
 */
export async function executeHooks(
  registry: HookRegistry,
  payload: HookPayload,
  runtime: HookRuntimeContext,
  options: ExecuteHooksOptions = {},
): Promise<HookRunSummary> {
  const resolved = {
    timeoutMs: options.timeoutMs ?? HOOK_TIMEOUT_MS,
    termGraceMs: options.termGraceMs ?? HOOK_TERM_GRACE_MS,
  }
  const results: HookExecutionResult[] = []

  for (const matcher of registry.match(payload.event, payload.tool)) {
    const started = performance.now()
    const matcherOptions = {
      ...resolved,
      timeoutMs: matcher.timeoutMs ?? resolved.timeoutMs,
    }
    let result: HookExecutionResult
    try {
      if (matcher.handler.type === 'shell') {
        result = await runShell(matcher.handler.command, payload, runtime, matcherOptions)
      } else {
        const controller = new AbortController()
        const handleParentAbort = () => controller.abort(runtime.abortSignal?.reason)
        if (runtime.abortSignal?.aborted) handleParentAbort()
        else runtime.abortSignal?.addEventListener('abort', handleParentAbort, { once: true })
        try {
          const queryContext = runtime.queryContext
            ? { ...runtime.queryContext, abortSignal: controller.signal }
            : undefined
          const call = withTimeout(
            matcher.handler.fn({
              ...runtime,
              abortSignal: controller.signal,
              queryContext,
              payload,
            }),
            matcherOptions.timeoutMs,
            () => controller.abort(new Error(`Hook timed out after ${matcherOptions.timeoutMs}ms`)),
          )
          const completed = await call
          if (completed.timedOut) {
            result = { outcome: 'timeout', denied: false }
          } else {
            const hookResult = completed.value
            result = {
              outcome: 'success',
              denied: hookResult?.action === 'deny',
              ...(hookResult?.reason ? { reason: hookResult.reason } : {}),
            }
          }
        } finally {
          runtime.abortSignal?.removeEventListener('abort', handleParentAbort)
        }
      }
    } catch (error) {
      dbg('hooks', 'Hook execution failed; continuing', { event: payload.event, error })
      result = { outcome: 'failure', denied: false }
    }
    if (result.outcome !== 'success') {
      dbg('hooks', 'Hook did not succeed; continuing', {
        event: payload.event,
        type: matcher.handler.type,
        outcome: result.outcome,
      })
    }
    journalHook(payload, matcher.handler.type, started, result.outcome)
    results.push(result)
  }

  const denial = results.find((result) => result.denied)
  return {
    denied: denial !== undefined,
    ...(denial?.reason ? { reason: denial.reason } : {}),
    results,
  }
}

/**
 * Executes hooks attached to a query context if a HookRegistry is present.
 *
 * @param context - Context object potentially containing an attached HookRegistry and repoRoot.
 * @param payload - Hook event payload.
 * @param state - Optional query state (system prompt and messages) for hook handlers.
 * @returns Summary of hook execution outcomes, or an empty result if no hooks are registered.
 */
export async function executeAttachedHooks(
  context: object & { repoRoot: string; abortSignal?: AbortSignal; hooks?: HookRegistry },
  payload: HookPayload,
  state?: HookContext['state'],
): Promise<HookRunSummary> {
  const registry = context.hooks
  if (!registry) return { denied: false, results: [] }
  return executeHooks(registry, payload, {
    repoRoot: context.repoRoot,
    abortSignal: context.abortSignal,
    state,
    queryContext: context,
  })
}
