import crypto from 'node:crypto'
import readline from 'node:readline'

// In-memory allowlist of approved exact commands for this session
const allowlist = new Set<string>()

/**
 * Computes a unique exact-input hash for a tool call.
 * Format: `${toolName}:${sha256(JSON.stringify(input)).slice(0,8)}`
 */
export function getPermissionKey(toolName: string, input: unknown): string {
  const serialized = JSON.stringify(input)
  const hash = crypto.createHash('sha256').update(serialized).digest('hex')
  return `${toolName}:${hash.slice(0, 8)}`
}

/**
 * Clears the session allowlist (mainly for unit tests).
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

export function registerPromptHandler(handler: PromptHandler): void {
  activePromptHandler = handler
}

export function unregisterPromptHandler(): void {
  activePromptHandler = null
}

/**
 * Requests permission to run a non-read-only tool.
 * Delegates to an active prompt handler if registered, otherwise falls back
 * to a clean interactive CLI console prompt.
 */
export async function requestPermission(
  toolName: string,
  input: unknown,
): Promise<'allow_once' | 'allow_always' | 'deny'> {
  const key = getPermissionKey(toolName, input)

  // If this exact parameters signature was already approved as 'always allow'
  if (allowlist.has(key)) {
    return 'allow_always'
  }

  // Delegate to active UI handler if registered (e.g. Ink TUI)
  if (activePromptHandler) {
    const decision = await activePromptHandler(toolName, input)
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
