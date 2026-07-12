import crypto from 'node:crypto'
import readline from 'node:readline'
import { isActiveConfigTrusted } from '../config/load'
import { appendJournal } from '../memory/journal'
import type { QueryLoopContext } from '../query/types'

// In-memory allowlist of approved exact commands for this session
const allowlist = new Set<string>()
const MAX_BUFFERED_PERMISSION_LINES = 32

/**
 * Computes a unique exact-input hash signature for a tool call.
 * @param toolName The name of the tool.
 * @param input The tool input payload.
 * @returns The generated permission key string.
 */
export function getPermissionKey(toolName: string, input: unknown): string {
  const serialized = JSON.stringify(input)
  const hash = crypto.createHash('sha256').update(serialized).digest('hex')
  return `${toolName}:${hash.slice(0, 8)}`
}

/**
 * Clears all approved keys from the current session allowlist.
 */
export function clearAllowlist(): void {
  allowlist.clear()
}

// Allows registering a custom prompt handler (e.g. delegated to visual React Ink UI)
type PromptHandler = (
  toolName: string,
  input: unknown,
) => Promise<'allow_once' | 'allow_always' | 'deny'>
let activePromptHandler: PromptHandler | null = null

interface FallbackPromptState {
  input: NodeJS.ReadableStream
  interface: readline.Interface
  bufferedLines: string[]
  pending?: (answer: string | null) => void
  eof: boolean
}

let fallbackPromptInput: NodeJS.ReadableStream = process.stdin
let fallbackPromptState: FallbackPromptState | undefined

function pauseFallbackPrompt(state: FallbackPromptState): void {
  state.interface.pause()
  state.input.pause()
}

function createFallbackPromptState(): FallbackPromptState {
  const promptInterface = readline.createInterface({
    input: fallbackPromptInput,
    output: process.stdout,
  })
  const state: FallbackPromptState = {
    input: fallbackPromptInput,
    interface: promptInterface,
    bufferedLines: [],
    eof: false,
  }

  promptInterface.on('line', (line) => {
    const pending = state.pending
    if (pending) {
      state.pending = undefined
      pauseFallbackPrompt(state)
      pending(line)
    } else {
      if (state.bufferedLines.length < MAX_BUFFERED_PERMISSION_LINES) {
        state.bufferedLines.push(line)
      }
      pauseFallbackPrompt(state)
    }
  })
  promptInterface.on('close', () => {
    state.eof = true
    const pending = state.pending
    if (pending) {
      state.pending = undefined
      pending(null)
    }
  })
  pauseFallbackPrompt(state)
  return state
}

function getFallbackPromptState(): FallbackPromptState {
  fallbackPromptState ??= createFallbackPromptState()
  return fallbackPromptState
}

function resetFallbackPromptState(): void {
  const state = fallbackPromptState
  fallbackPromptState = undefined
  if (!state) return
  pauseFallbackPrompt(state)
  state.interface.close()
}

async function readFallbackAnswer(prompt: string): Promise<string | null> {
  const state = getFallbackPromptState()
  const buffered = state.bufferedLines.shift()
  if (buffered !== undefined) {
    process.stdout.write(prompt)
    pauseFallbackPrompt(state)
    return buffered
  }
  if (state.eof) {
    process.stdout.write(prompt)
    return null
  }

  return new Promise((resolve) => {
    state.pending = resolve
    state.interface.setPrompt(prompt)
    state.interface.prompt()
  })
}

/**
 * Overrides one-shot permission input for tests and resets buffered prompt state.
 * Omit the argument to restore process.stdin.
 */
export function setPermissionInputStreamForTests(
  input: NodeJS.ReadableStream = process.stdin,
): void {
  resetFallbackPromptState()
  fallbackPromptInput = input
}

/** Exposes the bounded one-shot queue size for flooding regression tests. */
export function getBufferedPermissionLineCountForTests(): number {
  return fallbackPromptState?.bufferedLines.length ?? 0
}

/**
 * Registers a delegated UI handler to display permission prompts.
 * @param handler The delegated prompt handler callback.
 */
export function registerPromptHandler(handler: PromptHandler): void {
  activePromptHandler = handler
}

/**
 * Unregisters the currently active delegated UI prompt handler.
 */
export function unregisterPromptHandler(): void {
  activePromptHandler = null
}

/**
 * Requests permission from the user to execute a non-read-only tool.
 * @param toolName The name of the tool requesting permission.
 * @param input The validated input payload of the tool.
 * @param ctx The tool execution context.
 * @returns A promise resolving to the user's permission decision.
 */
export async function requestPermission(
  toolName: string,
  input: unknown,
  ctx?: QueryLoopContext,
): Promise<'allow_once' | 'allow_always' | 'deny'> {
  const key = getPermissionKey(toolName, input)

  const matchesPattern = (pattern: string): boolean => {
    if (!pattern.startsWith('Bash(')) return pattern === toolName
    if (toolName !== 'Bash' || typeof input !== 'object' || input === null) return false
    const command = 'command' in input ? input.command : undefined
    if (typeof command !== 'string') return false
    return command.startsWith(pattern.slice(5, -2))
  }

  const config = ctx?.config
  if (config) {
    if (config.permissions.denyPatterns.some(matchesPattern)) {
      appendJournal({ kind: 'permission', decision: 'deny', key, via: 'config' })
      return 'deny'
    }
    const allowPatternsTrusted = ctx ? await isActiveConfigTrusted(ctx.repoRoot, config) : true
    if (allowPatternsTrusted && config.permissions.allowPatterns.some(matchesPattern)) {
      appendJournal({ kind: 'permission', decision: 'allow_always', key, via: 'config' })
      return 'allow_always'
    }
  }

  // If this exact parameters signature was already approved as 'always allow'
  if (allowlist.has(key)) {
    return 'allow_always'
  }

  // Delegate to active UI handler if registered (e.g. Ink TUI)
  if (activePromptHandler) {
    const decision = await activePromptHandler(toolName, input)
    appendJournal({
      kind: 'permission',
      decision,
      key,
    })
    if (decision === 'allow_always') {
      allowlist.add(key)
    }
    return decision
  }

  // Interactive console CLI fallback for verification
  console.log(`\n⚠️  [Permission Request] Tool: ${toolName}`)
  console.log(`Parameters: ${JSON.stringify(input, null, 2)}`)
  const answer = await readFallbackAnswer(
    'Allow execution? [y] Yes once / [n] No / [a] Always for this input: ',
  )
  const normalized = answer?.trim().toLowerCase()
  const decision = normalized === 'y' ? 'allow_once' : normalized === 'a' ? 'allow_always' : 'deny'
  if (decision === 'allow_always') {
    allowlist.add(key)
  }
  appendJournal({
    kind: 'permission',
    decision,
    key,
  })
  return decision
}
