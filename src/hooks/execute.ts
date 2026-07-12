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

export interface ExecuteHooksOptions {
  timeoutMs?: number
  termGraceMs?: number
}

type HookRuntimeContext = Omit<HookContext, 'payload'>

function hookDuration(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}

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
