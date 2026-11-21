import crypto from 'node:crypto'
import { getConfigTrustWarning, loadConfig } from '../config/load'
import type { OctonoesisConfig } from '../config/schema'
import { formatMemoryUnavailableNotice, initializeMemoryAvailability } from '../memory/availability'
import { flushJournal, formatJournalFailureNotice } from '../memory/journal'
import { getResolvedModel, setConfiguredModel } from '../providers'
import { claimProcessSignals } from '../providers/fork'
import type { QueryLoopContext } from '../query/types'
import { assertSandboxAvailable, resolveSandboxConfig } from '../sandbox/manager'
import { createSessionState, flushSessionStats } from '../state/session'
import { cleanupTasks } from '../tasks/framework'
import { dbg } from '../utils/debug'
import { hasAnthropicKey, hasOpenAIKey, hasSparkKey } from '../utils/env'

export async function loadSessionConfig(repoRoot: string) {
  const config = await loadConfig(repoRoot)
  setConfiguredModel(config.model)
  const warning = await getConfigTrustWarning(repoRoot, config)
  if (warning) console.error(warning)
  return config
}

export function sessionSandbox(repoRoot: string, config: OctonoesisConfig, cliEnabled?: boolean) {
  const resolved = resolveSandboxConfig({ repoRoot, cliEnabled, config: config.sandbox })
  if (!resolved.enabled) return undefined
  assertSandboxAvailable()
  return resolved
}

export async function initializeSessionMemory(memoryDir: string) {
  await initializeMemoryAvailability(memoryDir)
}

export function createInteractiveContext(
  repoRoot: string,
  memoryDir: string,
  config: OctonoesisConfig,
  options: Partial<QueryLoopContext> = {},
): QueryLoopContext & { sessionId: string } {
  const sessionId = crypto.randomUUID()
  return {
    repoRoot,
    memoryDir,
    sessionId,
    sessionState: createSessionState(sessionId, getResolvedModel()),
    messages: [],
    tasks: new Map(),
    config,
    ...options,
  }
}

export async function finishInteractiveSession(ctx: QueryLoopContext, summary?: () => void) {
  try {
    await cleanupTasks(ctx)
  } catch (error) {
    dbg('cli', 'Failed to clean up background tasks', error)
  }
  await flushSessionStats()
  summary?.()
  await flushJournal()
  const memoryNotice = formatMemoryUnavailableNotice()
  if (memoryNotice) console.error(memoryNotice)
  const journalNotice = formatJournalFailureNotice()
  if (journalNotice) console.error(journalNotice)
}

/** The TUI retains its signal codes; the stdio host opts into normal exit. */
export function sessionSignals(onAbort: () => void, normalExit = false) {
  claimProcessSignals()
  let exitCode: number | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const handlers = Object.entries({ SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }).map(
    ([signal, code]) => {
      const handler = () => {
        if (exitCode !== undefined) process.exit(exitCode)
        exitCode = normalExit ? 0 : code
        deadline = setTimeout(() => process.exit(exitCode), 3000)
        onAbort()
      }
      process.on(signal, handler)
      return { signal, handler }
    },
  )
  return {
    finish() {
      if (exitCode !== undefined) process.exit(exitCode)
      if (deadline) clearTimeout(deadline)
      for (const { signal, handler } of handlers) process.removeListener(signal, handler)
    },
  }
}

/**
 * Validates that required API key environment variables are configured for the active LLM provider.
 *
 * Throws the existing CLI diagnostic when a required key is missing.
 */
export function checkApiKey(): void {
  const provider = (process.env.LLM_PROVIDER || 'spark').toLowerCase()
  if (provider === 'spark' && !hasSparkKey()) {
    throw new Error('Error: SPARK_API_KEY is not set. Add it to your environment or .env file.')
  }
  if (provider === 'anthropic' && !hasAnthropicKey()) {
    throw new Error(
      'Error: ANTHROPIC_API_KEY is not set.\n\n' +
        'Set it in your environment:\n' +
        '  export ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        'Or switch to OpenAI:\n' +
        '  export LLM_PROVIDER=openai\n' +
        '  export OPENAI_API_KEY=sk-proj-...',
    )
  }
  if (provider === 'openai' && !hasOpenAIKey()) {
    throw new Error(
      'Error: OPENAI_API_KEY is not set.\n\n' +
        'Set it in your environment:\n' +
        '  export OPENAI_API_KEY=sk-proj-...',
    )
  }
}
