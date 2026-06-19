import crypto from 'node:crypto'
import readline from 'node:readline'
import { appendJournal } from '../memory/journal'

// In-memory allowlist of approved exact commands for this session
const allowlist = new Set<string>()

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
 * @returns A promise resolving to the user's permission decision.
 */
export async function requestPermission(
  toolName: string,
  input: unknown,
  ctx?: unknown, // Accept optional context parameter
): Promise<'allow_once' | 'allow_always' | 'deny'> {
  const key = getPermissionKey(toolName, input)

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
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    console.log(`\n⚠️  [Permission Request] Tool: ${toolName}`)
    console.log(`Parameters: ${JSON.stringify(input, null, 2)}`)

    rl.question(
      'Allow execution? [y] Yes once / [n] No / [a] Always for this input: ',
      (answer) => {
        rl.close()
        const normalized = answer.trim().toLowerCase()
        if (normalized === 'y') {
          resolve('allow_once')
        } else if (normalized === 'a') {
          allowlist.add(key)
          resolve('allow_always')
        } else {
          resolve('deny')
        }
      },
    )
  })
}
