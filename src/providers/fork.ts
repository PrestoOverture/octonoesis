// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the runtime.
declare const Bun: any

import { realpathSync } from 'node:fs'
import type { ExitReason } from '../query/types'
import { getProviderCredentialEnvironment } from '../utils/env'
import { getCheapestModel } from './index'
import type { CanonicalMessage, CanonicalTool, Usage } from './types'

export type ForkPurpose =
  | 'compact'
  | 'memory_extract'
  | 'memory_recall'
  | 'skill'
  | 'tool_summary'
  | 'agent'

export interface ForkOptions {
  systemPrompt: string
  messages: CanonicalMessage[]
  tools: CanonicalTool[]
  model?: string
  maxTurns?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  forkPurpose: ForkPurpose
  repoRoot?: string
}

export interface ForkResult {
  text: string
  usage: Usage
  turns: number
  exitReason: ExitReason
  error?: string
  systemPromptSha256?: string
}

export interface PreparedFork {
  repoRoot: string
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
  agent: ['Read', 'Grep', 'Glob'],
}

export const MEMORY_EXTRACT_WRITE_SCOPE = '.octonoesis/memory/'
export const DEFAULT_FORK_TIMEOUT_MS = 60_000

const FORK_ABORT_GRACE_MS = 2000

interface ForkSubprocess {
  pid: number
  stdin: {
    write(data: string): unknown
    end(): unknown
  }
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: NodeJS.Signals): void
}

export interface ForkHandle {
  pid: number
  result: Promise<ForkResult>
  sendMessage(message: string): { ok: true } | { ok: false; error: string }
  kill(): Promise<void>
}

const activeForkChildren = new Set<ForkSubprocess>()
const EXIT_REASONS = new Set<ExitReason>([
  'completed',
  'max_turns',
  'fatal_error',
  'user_cancel',
  'budget_exceeded',
  'prompt_too_long',
])

const AGENT_TOOL_NAMES = new Set(['Agent', 'AgentTool'])

/**
 * Error thrown when a proposed fork violates constitutional isolation invariants
 * (e.g. recursion depth > 1, or requesting disallowed tools).
 */
export class ForkInvariantError extends Error {
  readonly reason: 'recursion_depth' | 'tool_not_allowed'

  /**
   * @param reason Specific invariant violation reason.
   */
  constructor(reason: 'recursion_depth' | 'tool_not_allowed') {
    super(`Fork invariant violated: ${reason}`)
    this.name = 'ForkInvariantError'
    this.reason = reason
  }
}

/**
 * Reads the current fork recursion depth from the environment.
 * @param env Optional environment map; defaults to process.env.
 * @returns Non-negative integer indicating fork depth.
 */
export function getForkDepth(env: Record<string, string | undefined> = process.env): number {
  const depth = Number(env.OCTONOESIS_FORK_DEPTH)
  return Number.isInteger(depth) && depth > 0 ? depth : 0
}

/**
 * Validates and prepares options for spawning a child fork process.
 * Enforces depth limit, purpose-specific tool allowlists, budget bounds, and path resolution.
 * @param opts User-supplied ForkOptions.
 * @returns PreparedFork structure ready for child serialization.
 * @throws {ForkInvariantError} If fork depth is exceeded or tools are disallowed for the fork purpose.
 * @throws {RangeError} If maxTurns is not a positive integer.
 */
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
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new RangeError('Fork maxTurns must be a positive integer')
  }

  return {
    repoRoot: realpathSync(opts.repoRoot ?? process.cwd()),
    systemPrompt: opts.systemPrompt,
    messages: structuredClone(opts.messages),
    tools: structuredClone(opts.tools),
    childEnv: { OCTONOESIS_FORK_DEPTH: String(depth + 1) },
    budget: {
      maxTurns,
      ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
    },
    purpose: opts.forkPurpose,
    model: opts.model ?? getCheapestModel(),
  }
}

/**
 * Builds the executable command arguments to spawn the current agent executable in fork child mode.
 * @param execPath Executable path (defaults to process.execPath).
 * @param main Main entry script path (defaults to Bun.main).
 * @returns Array of command arguments.
 */
export function buildForkCommand(
  execPath: string = process.execPath,
  main: string = Bun.main,
): string[] {
  const isCompiled = main === execPath || main.startsWith('/$bunfs/')
  return isCompiled ? [execPath, '--fork-child'] : [execPath, main, '--fork-child']
}

/**
 * Serializes a PreparedFork object to a JSON string payload for transmission via child stdin.
 * @param prepared The PreparedFork object.
 * @returns The serialized JSON payload string.
 * @throws {TypeError} If serialization produces undefined.
 */
export function serializeForkPayload(prepared: PreparedFork): string {
  const payload = JSON.stringify(prepared)
  if (payload === undefined) {
    throw new TypeError('Fork payload could not be serialized')
  }
  return payload
}

/**
 * Returns an array of process IDs for all currently active fork child subprocesses.
 * @returns Array of active child PIDs.
 */
export function getActiveForkPids(): number[] {
  return Array.from(activeForkChildren, (child) => child.pid)
}

/**
 * Force-terminates all active child processes with SIGKILL.
 */
function forceKillForkChildren(): void {
  for (const child of activeForkChildren) {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

/**
 * Builds the provider-capable environment used only by fork child processes.
 * Includes provider API credentials and the child's specific environment flags.
 * @param childEnv Additional child environment variables.
 * @param source Base environment record (defaults to process.env).
 * @returns Combined environment object for spawning fork children.
 */
export function buildForkChildEnvironment(
  childEnv: Record<string, string>,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...getProviderCredentialEnvironment(), ...childEnv }
}

/**
 * Registers signal handlers on the parent process to kill all active fork children on exit or termination.
 * @param signal Termination signal ('SIGINT' or 'SIGTERM').
 */
function installParentSignalCleanup(signal: 'SIGINT' | 'SIGTERM'): void {
  const handleSignal = () => {
    forceKillForkChildren()
    if (process.listenerCount(signal) === 1) {
      process.removeListener(signal, handleSignal)
      process.kill(process.pid, signal)
    }
  }
  process.on(signal, handleSignal)
}

process.once('exit', forceKillForkChildren)
installParentSignalCleanup('SIGINT')
installParentSignalCleanup('SIGTERM')

/**
 * Type guard checking whether a value is a non-null, non-array object.
 * @param value The value to inspect.
 * @returns True if value is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates and parses the single JSON-line output emitted by a completed fork child process.
 * @param output Raw stdout string from the fork child.
 * @returns The parsed ForkResult object.
 * @throws {TypeError} If output is not exactly one line or fails schema validation.
 */
function parseForkResult(output: string): ForkResult {
  const line = output.trim()
  if (line.length === 0 || line.split(/\r?\n/).length !== 1) {
    throw new TypeError('Fork child output must be exactly one JSON line')
  }

  const result: unknown = JSON.parse(line)
  if (!isRecord(result) || !isRecord(result.usage)) {
    throw new TypeError('Fork child output is not a ForkResult')
  }

  const isValid =
    typeof result.text === 'string' &&
    typeof result.usage.input_tokens === 'number' &&
    Number.isFinite(result.usage.input_tokens) &&
    typeof result.usage.output_tokens === 'number' &&
    Number.isFinite(result.usage.output_tokens) &&
    Number.isInteger(result.turns) &&
    (result.turns as number) >= 0 &&
    typeof result.exitReason === 'string' &&
    EXIT_REASONS.has(result.exitReason as ExitReason) &&
    (result.error === undefined || typeof result.error === 'string') &&
    (result.systemPromptSha256 === undefined || typeof result.systemPromptSha256 === 'string')

  if (!isValid) {
    throw new TypeError('Fork child output is not a ForkResult')
  }
  return result as unknown as ForkResult
}

/**
 * Constructs a standardized fatal_error ForkResult from an error value.
 * @param error The error value or message.
 * @returns A ForkResult with exitReason 'fatal_error'.
 */
function runtimeFailure(error: unknown): ForkResult {
  return {
    text: '',
    usage: { input_tokens: 0, output_tokens: 0 },
    turns: 0,
    exitReason: 'fatal_error',
    error: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Constructs a standardized user_cancel ForkResult.
 * @returns A ForkResult with exitReason 'user_cancel'.
 */
function userCancellation(): ForkResult {
  return {
    text: '',
    usage: { input_tokens: 0, output_tokens: 0 },
    turns: 0,
    exitReason: 'user_cancel',
    error: 'Fork aborted by user',
  }
}

/**
 * Gracefully terminates a fork child with SIGTERM, escalating to SIGKILL after a grace period.
 * @param child The ForkSubprocess to terminate.
 */
async function terminateForkChild(child: ForkSubprocess): Promise<void> {
  try {
    child.kill('SIGTERM')
  } catch {}

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const exitedDuringGrace = await Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolveGrace) => {
      graceTimer = setTimeout(() => resolveGrace(false), FORK_ABORT_GRACE_MS)
    }),
  ])
  if (graceTimer) clearTimeout(graceTimer)

  if (!exitedDuringGrace) {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
  await child.exited
}

/**
 * Spawns a new fork child subprocess using Bun.spawn and adds it to the active tracking set.
 * @param prepared Validated and prepared fork parameters.
 * @returns The spawned ForkSubprocess handle.
 */
function spawnForkChild(prepared: PreparedFork): ForkSubprocess {
  const child = Bun.spawn({
    cmd: buildForkCommand(),
    cwd: prepared.repoRoot,
    env: buildForkChildEnvironment(prepared.childEnv),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  }) as ForkSubprocess
  activeForkChildren.add(child)
  return child
}

/**
 * Spawns an isolated forked agent child process, awaits its completion, and parses its output.
 * Handles timeouts, user cancellation, process lifecycle, and cleanup.
 * @param opts Options configuring prompt, messages, tools, model, and limits.
 * @returns The ForkResult summarizing output, usage, and exit reason.
 */
export async function forkAgent(opts: ForkOptions): Promise<ForkResult> {
  const prepared = prepareForkInput(opts)
  if (opts.signal?.aborted) return userCancellation()

  const timeoutMs = opts.timeoutMs ?? DEFAULT_FORK_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return runtimeFailure('Fork timeoutMs must be a non-negative finite number')
  }

  let child: ForkSubprocess | undefined
  let childReaped = false
  let stdoutPromise: Promise<string> | undefined
  let stderrPromise: Promise<string> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let handleAbort: (() => void) | undefined

  type ControlOutcome = { kind: 'abort' } | { kind: 'timeout' }
  const controlOutcomes: Promise<ControlOutcome>[] = [
    new Promise((resolveTimeout) => {
      timeoutTimer = setTimeout(() => resolveTimeout({ kind: 'timeout' }), timeoutMs)
      timeoutTimer.unref()
    }),
  ]
  if (opts.signal) {
    controlOutcomes.push(
      new Promise((resolveAbort) => {
        handleAbort = () => resolveAbort({ kind: 'abort' })
        if (opts.signal?.aborted) {
          handleAbort()
        } else {
          opts.signal?.addEventListener('abort', handleAbort, { once: true })
        }
      }),
    )
  }

  try {
    const payload = serializeForkPayload(prepared)
    child = spawnForkChild(prepared)

    stdoutPromise = new Response(child.stdout).text()
    stderrPromise = new Response(child.stderr).text()
    const childCompletion = (async () => {
      child.stdin.write(payload)
      await child.stdin.end()
      const exitCode = await child.exited
      childReaped = true
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
      return { kind: 'exit' as const, exitCode, stderr, stdout }
    })()

    const outcome = await Promise.race([childCompletion, ...controlOutcomes])
    if (outcome.kind !== 'exit') {
      await terminateForkChild(child)
      childReaped = true
      await Promise.allSettled([childCompletion, stdoutPromise, stderrPromise])
      if (outcome.kind === 'abort') return userCancellation()
      return runtimeFailure(`Fork timed out after ${timeoutMs}ms`)
    }

    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || `Fork child exited with code ${outcome.exitCode}`
      return runtimeFailure(detail)
    }
    return parseForkResult(outcome.stdout)
  } catch (error) {
    if (child && !childReaped) {
      await terminateForkChild(child)
      childReaped = true
    }
    await Promise.allSettled([stdoutPromise, stderrPromise].filter((value) => value !== undefined))
    return runtimeFailure(error)
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (opts.signal && handleAbort) {
      opts.signal.removeEventListener('abort', handleAbort)
    }
    if (child) activeForkChildren.delete(child)
  }
}

/**
 * Starts a background agent fork with stdin kept open for bounded NDJSON message delivery.
 * @param opts Options configuring prompt, messages, tools, model, and limits.
 * @returns A ForkHandle with PID, completion promise, sendMessage, and kill controls.
 * @throws {ForkInvariantError} If forkPurpose is not 'agent'.
 * @throws {RangeError} If timeoutMs is negative.
 */
export function startForkAgent(opts: ForkOptions): ForkHandle {
  if (opts.forkPurpose !== 'agent') {
    throw new ForkInvariantError('tool_not_allowed')
  }
  const prepared = prepareForkInput(opts)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FORK_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('Fork timeoutMs must be a non-negative finite number')
  }

  const child = spawnForkChild(prepared)
  child.stdin.write(`${serializeForkPayload(prepared)}\n`)

  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  let sentMessages = 0
  let finished = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let handleAbort: (() => void) | undefined

  const result = (async (): Promise<ForkResult> => {
    type ControlOutcome = { kind: 'abort' } | { kind: 'timeout' }
    const controls: Promise<ControlOutcome>[] = [
      new Promise((resolve) => {
        timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
        timeoutTimer.unref()
      }),
    ]
    if (opts.signal) {
      controls.push(
        new Promise((resolve) => {
          handleAbort = () => resolve({ kind: 'abort' })
          if (opts.signal?.aborted) handleAbort()
          else opts.signal?.addEventListener('abort', handleAbort, { once: true })
        }),
      )
    }

    const completion = (async () => {
      const exitCode = await child.exited
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
      return { kind: 'exit' as const, exitCode, stdout, stderr }
    })()

    try {
      const outcome = await Promise.race([completion, ...controls])
      if (outcome.kind !== 'exit') {
        await terminateForkChild(child)
        await Promise.allSettled([completion, stdoutPromise, stderrPromise])
        return outcome.kind === 'abort'
          ? userCancellation()
          : runtimeFailure(`Fork timed out after ${timeoutMs}ms`)
      }
      if (outcome.exitCode !== 0) {
        return runtimeFailure(
          outcome.stderr.trim() || `Fork child exited with code ${outcome.exitCode}`,
        )
      }
      return parseForkResult(outcome.stdout)
    } catch (error) {
      try {
        await terminateForkChild(child)
      } catch {}
      return runtimeFailure(error)
    } finally {
      finished = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (opts.signal && handleAbort) opts.signal.removeEventListener('abort', handleAbort)
      activeForkChildren.delete(child)
      try {
        await child.stdin.end()
      } catch {}
    }
  })()

  return {
    pid: child.pid,
    result,
    sendMessage(message) {
      if (finished) return { ok: false, error: 'Agent is no longer running.' }
      if (sentMessages >= 16) return { ok: false, error: 'Agent message queue is full.' }
      try {
        child.stdin.write(`${JSON.stringify({ type: 'message', text: message })}\n`)
        sentMessages++
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async kill() {
      if (!finished) await terminateForkChild(child)
      await result
    },
  }
}
