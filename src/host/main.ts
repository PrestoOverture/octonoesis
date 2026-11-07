import { Console } from 'node:console'
import readline from 'node:readline'
import { createPatch } from 'diff'
import { version } from '../../package.json'
import { checkpointTimeline, ruleSummaries, sessionChanges } from './checkpoints'
import { editSummary, historyEntries, rewindNotice, sessionSummaries } from './history'
import {
  type HostMessage,
  type PermissionDecision,
  type TaskSummary,
  parseHostCommand,
} from './protocol'

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
const resumeIndex = process.argv.indexOf('--resume')
const resumeId = resumeIndex === -1 ? undefined : process.argv[resumeIndex + 1]

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
  const { registerPromptHandler, unregisterPromptHandler, setPermissionMode } = await import(
    '../permissions/confirm'
  )
  const { query, formatQueryFailure } = await import('../query')
  const { rewriteSkillSlashCommand } = await import('../skills/execute')
  const { loadSkills } = await import('../skills/loader')
  const { listSessions, loadSession } = await import('../state/sessionStore')
  const { getTodos, subscribeTodos } = await import('../state/todos')
  const { loadFileHistory, planFileRestore, restoreFiles } = await import('../state/fileHistory')
  const { loadAllRules } = await import('../memory/rules/store')
  const path = await import('node:path')
  const { contextTokensWithEstimation, getContextWindowSize } = await import('../utils/tokens')
  const { estimateCost } = await import('../utils/cost')
  const repoRoot = getRepoRoot()
  const config = await loadSessionConfig(repoRoot)
  const memoryDir = getMemoryDir()
  await initializeSessionMemory(memoryDir)
  const sandbox = sessionSandbox(repoRoot, config)
  checkApiKey()
  if (resumeIndex !== -1 && !resumeId) throw new Error('--resume requires a session id')
  const resumed = resumeId ? await loadSession(resumeId, { memoryDir }) : undefined
  if (resumed && resumed.repo_root !== repoRoot)
    throw new Error(`Saved session ${resumeId} belongs to ${resumed.repo_root}`)
  // Like the TUI, a resumed conversation continues under a new session id so the
  // journal's per-session learning accounting never mixes two host processes.
  const ctx = createInteractiveContext(repoRoot, memoryDir, config, {
    sandbox,
    persistSession: true,
    messages: structuredClone(resumed?.messages ?? []),
  })
  let active: Promise<void> | undefined
  let controller: AbortController | undefined
  let stopping: Promise<void> | undefined
  let priced = false
  // Files rewound since the last turn; the next prompt tells the model about them.
  let rewindNotes: string[] = []
  const pending = new Map<string, (decision: PermissionDecision) => void>()
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  setPermissionMode('ask')
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
      clearInterval(taskPoll)
      unsubscribeTodos()
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
  send({ v: 1, type: 'permission_mode', mode: 'ask' })
  if (resumed)
    send({
      v: 1,
      type: 'history',
      resumedFrom: resumed.session_id,
      updatedAt: resumed.updated_at,
      entries: historyEntries(resumed.messages),
    })
  if (resumed && ctx.sessionState) {
    // The status bar's context share is otherwise unknown until the next turn ends.
    ctx.sessionState.contextUtilization =
      contextTokensWithEstimation(ctx.messages ?? []) / getContextWindowSize(ctx.sessionState.model)
    priced = estimateCost(ctx.sessionState.usage, ctx.sessionState.model).priced
    send({
      v: 1,
      type: 'event',
      event: {
        type: 'session_state',
        sessionState: { ...ctx.sessionState, usage: { ...ctx.sessionState.usage } },
        priced,
      },
    })
  }
  const sendSessions = async () => {
    try {
      const sessions = await listSessions({ memoryDir, repoRoot })
      send({ v: 1, type: 'sessions', sessions: sessionSummaries(sessions) })
    } catch (error) {
      console.error(`Could not list saved sessions: ${detail(error)}`)
    }
  }
  const fileHistory = async () => {
    try {
      return await loadFileHistory(memoryDir, ctx.sessionId, repoRoot)
    } catch (error) {
      // No Write/Edit yet: the session has no manifest.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  let lastCheckpoints = ''
  const sendCheckpoints = async () => {
    try {
      const timeline = checkpointTimeline(await fileHistory())
      const serialized = JSON.stringify(timeline)
      if (serialized === lastCheckpoints) return
      lastCheckpoints = serialized
      send({ v: 1, type: 'checkpoints', ...timeline })
    } catch (error) {
      console.error(`Could not read file checkpoints: ${detail(error)}`)
    }
  }
  const rewind = async (seq: number, force: boolean) => {
    try {
      const history = await fileHistory()
      if (!history?.entries.some((entry) => entry.seq === seq))
        throw new Error(`Checkpoint ${seq} is not part of this session`)
      const plan = planFileRestore(history, seq)
      await restoreFiles(memoryDir, ctx.sessionId, history, plan, force)
      const restored = plan.map((item) => item.path)
      rewindNotes.push(
        `Before checkpoint ${seq}: ${plan.map((item) => `${item.snapshot === 'absent' ? 'deleted' : 'restored'} ${item.path}`).join(', ')}`,
      )
      send({ v: 1, type: 'rewound', seq, restored })
    } catch (error) {
      const changed = detail(error).match(
        /^File changed after session's last write: (.*) \(use --force/,
      )
      send({
        v: 1,
        type: 'rewind_failed',
        seq,
        conflict: !!changed,
        message: changed ? `${changed[1]} changed after Noe's last write to it.` : detail(error),
      })
    }
  }
  // Never await before the line handler below: readline drops lines nobody listens for.
  void sendSessions()
  void sendCheckpoints()
  void loadSkills(repoRoot).then(
    (skills) =>
      send({
        v: 1,
        type: 'skills',
        skills: skills.map(({ name, description }) => ({ name, description })),
      }),
    (error) => console.error(`Could not load skills: ${detail(error)}`),
  )
  send({ v: 1, type: 'todos', todos: getTodos() })
  const unsubscribeTodos = subscribeTodos(() => send({ v: 1, type: 'todos', todos: getTodos() }))
  let lastTasks = '[]'
  const taskPoll = setInterval(() => {
    const tasks: TaskSummary[] = [...(ctx.tasks?.values() ?? [])].map(
      ({ id, type, status, startTime, endTime, command }) => ({
        id,
        type,
        status,
        startTime,
        ...(endTime === undefined ? {} : { endTime }),
        ...(command === undefined ? {} : { command }),
      }),
    )
    const serialized = JSON.stringify(tasks)
    if (serialized === lastTasks) return
    lastTasks = serialized
    send({ v: 1, type: 'tasks', tasks })
  }, 500)
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
        case 'set_permission_mode':
          setPermissionMode(command.mode)
          send({ v: 1, type: 'permission_mode', mode: command.mode })
          break
        case 'get_changes':
          void fileHistory()
            .then((history) => sessionChanges(memoryDir, ctx.sessionId, history))
            .then(
              (files) => send({ v: 1, type: 'changes', files }),
              (error) =>
                send({
                  v: 1,
                  type: 'error',
                  message: `Could not compute changes: ${detail(error)}`,
                }),
            )
          break
        case 'get_learning':
          void loadAllRules(path.join(memoryDir, 'rules')).then(
            (rules) => send({ v: 1, type: 'learning', rules: ruleSummaries(rules) }),
            (error) =>
              send({ v: 1, type: 'error', message: `Could not load rules: ${detail(error)}` }),
          )
          break
        case 'rewind': {
          if (active) {
            send({
              v: 1,
              type: 'rewind_failed',
              seq: command.seq,
              conflict: false,
              message: 'Wait for the current turn to finish before rewinding.',
            })
            break
          }
          active = rewind(command.seq, command.force === true).finally(() => {
            active = undefined
            void sendCheckpoints()
          })
          break
        }
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
              const notes = rewindNotes
              rewindNotes = []
              const prompt =
                rewindNotice(notes) + (await rewriteSkillSlashCommand(command.text, repoRoot))
              const generator = query(prompt, ctx, turnController.signal)
              const editSummaries = new Map<string, string>()
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
                let event = step.value
                if (event.type === 'tool_use' && event.name === 'Edit') {
                  const summary = editSummary(event.input)
                  if (summary) editSummaries.set(event.id, summary)
                }
                if (
                  event.type === 'tool_done' &&
                  event.status === 'done' &&
                  editSummaries.has(event.id)
                ) {
                  event = { ...event, summary: editSummaries.get(event.id) }
                }
                if (event.type === 'session_state') priced = event.priced
                send({ v: 1, type: 'event', event })
                if (event.type === 'tool_done' && ['Write', 'Edit', 'Bash'].includes(event.name))
                  void sendCheckpoints()
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
              // Query finalization saved the session; refresh the sidebar list.
              void sendSessions()
              void sendCheckpoints()
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
