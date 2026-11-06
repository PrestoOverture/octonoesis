import { Console } from 'node:console'
import readline from 'node:readline'
import { createPatch } from 'diff'
import { version } from '../../package.json'
import { type HostMessage, type PermissionDecision, parseHostCommand } from './protocol'

// Engine forks relaunch Bun.main with this flag, just as they do for the CLI.
if (process.argv.includes('--fork-child')) {
  const { forkChildMain } = await import('../providers/forkChild')
  process.exit(await forkChildMain())
}

// Reserve the original writer before loading engine code. Even dependency diagnostics
// and direct stdout writes must go to stderr, never into the protocol stream.
const protocolWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = process.stderr.write.bind(process.stderr)
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
const send = (message: HostMessage) => protocolWrite(`${JSON.stringify(message)}\n`)
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error))

try {
  const {
    checkApiKey,
    loadSessionConfig,
    sessionSandbox,
    initializeSessionMemory,
    createInteractiveContext,
    finishInteractiveSession,
    sessionSignals,
  } = await import('../session/lifecycle')
  const { getRepoRoot, getMemoryDir } = await import('../utils/path')
  const { getResolvedModel } = await import('../providers')
  const { formatSessionSummary } = await import('../state/session')
  const { registerPromptHandler, unregisterPromptHandler } = await import('../permissions/confirm')
  const { query, formatQueryFailure } = await import('../query')
  const { rewriteSkillSlashCommand } = await import('../skills/execute')
  const repoRoot = getRepoRoot()
  const config = await loadSessionConfig(repoRoot)
  const memoryDir = getMemoryDir()
  await initializeSessionMemory(memoryDir)
  const sandbox = sessionSandbox(repoRoot, config)
  checkApiKey()
  const ctx = createInteractiveContext(repoRoot, memoryDir, config, {
    sandbox,
    persistSession: true,
  })
  let active: Promise<void> | undefined
  let controller: AbortController | undefined
  let stopping: Promise<void> | undefined
  let priced = false
  const pending = new Map<string, (decision: PermissionDecision) => void>()
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  registerPromptHandler(
    (toolName, input, signal) =>
      new Promise((resolve) => {
        const requestId = crypto.randomUUID()
        const settle = (decision: PermissionDecision) => {
          pending.delete(requestId)
          signal?.removeEventListener('abort', abort)
          resolve(decision)
        }
        const abort = () => settle('deny')
        if (signal?.aborted) return abort()
        pending.set(requestId, settle)
        signal?.addEventListener('abort', abort, { once: true })
        const value = input as { path?: string; old_string?: string; new_string?: string }
        const preview =
          toolName === 'Write' &&
          typeof value?.old_string === 'string' &&
          typeof value?.new_string === 'string'
            ? createPatch(value.path ?? 'file', value.old_string, value.new_string)
            : undefined
        send({
          v: 1,
          type: 'permission_request',
          requestId,
          toolName,
          input,
          ...(preview ? { preview } : {}),
        })
      }),
  )

  const shutdown = () => {
    stopping ??= Promise.resolve().then(async () => {
      controller?.abort()
      input.close()
      await active
      unregisterPromptHandler()
      await finishInteractiveSession(ctx, () => {
        if (ctx.sessionState) console.error(formatSessionSummary(ctx.sessionState, priced))
      })
      signals.finish()
      process.exit(0)
    })
    return stopping
  }
  const signals = sessionSignals(() => {
    void shutdown()
  }, true)
  send({
    v: 1,
    type: 'ready',
    sessionId: ctx.sessionId,
    model: getResolvedModel(),
    repoRoot,
    version,
  })
  input.on('line', (line) => {
    if (stopping) return
    try {
      const command = parseHostCommand(line)
      switch (command.type) {
        case 'shutdown':
          void shutdown()
          break
        case 'cancel':
          controller?.abort()
          break
        case 'permission_reply': {
          const settle = pending.get(command.requestId)
          if (!settle) throw new Error('Unknown permission request')
          settle(command.decision)
          break
        }
        case 'submit': {
          if (active) throw new Error('A turn is already running')
          const turnController = new AbortController()
          controller = turnController
          active = (async () => {
            try {
              const prompt = await rewriteSkillSlashCommand(command.text, repoRoot)
              const generator = query(prompt, ctx, turnController.signal)
              while (true) {
                const step = await generator.next()
                if (step.done) {
                  send({
                    v: 1,
                    type: 'turn_end',
                    exitReason: step.value.exit_reason,
                    failure: formatQueryFailure(step.value),
                  })
                  break
                }
                if (step.value.type === 'session_state') priced = step.value.priced
                send({ v: 1, type: 'event', event: step.value })
              }
            } catch (error) {
              send({
                v: 1,
                type: 'turn_end',
                exitReason: turnController.signal.aborted ? 'user_cancel' : 'fatal_error',
                failure: detail(error),
              })
            } finally {
              active = undefined
              controller = undefined
            }
          })()
        }
      }
    } catch (error) {
      send({ v: 1, type: 'error', message: detail(error) })
    }
  })
  input.on('close', () => {
    void shutdown()
  })
} catch (error) {
  send({ v: 1, type: 'fatal', message: detail(error) })
  process.exit(1)
}
