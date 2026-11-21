import { Electroview } from 'electrobun/view'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type { HostCommand, PermissionDecision, PermissionMode } from '../../../src/host/protocol'
import { Markdown } from '../shared/Markdown'
import { activityBlocks } from '../shared/activity'
import type { DesktopRPC } from '../shared/rpc'
import { type Action, initialTranscript, slashMatches, toolArgument } from '../shared/transcript'
import {
  MAX_SESSIONS,
  type WorkspaceAction,
  initialWorkspace,
  liveSessionIds,
  sessionStatus,
  sessionTitle,
  workspace,
} from '../shared/workspace'
import { ActivityGroup, ToolCard } from './Activity'
import { SettingsDialog } from './Settings'
import { type PanelTab, SidePanel } from './SidePanel'
import compactNoe from './assets/noe-compact.svg'
import noe from './assets/noe-f11.svg'

let push: ((action: WorkspaceAction) => void) | undefined
const rpc = Electroview.defineRPC<DesktopRPC>({
  maxRequestTime: 15000,
  handlers: {
    requests: {},
    messages: {
      host: ({ key, message }) => push?.({ type: 'session', key, action: message }),
      hostExit: ({ key, message }) =>
        push?.({ type: 'session', key, action: { type: 'host_exit', message } }),
    },
  },
})
new Electroview({ rpc })
const settingsRequests = {
  get: () => rpc.request.getProviderSettings(undefined),
  setProvider: (provider: Parameters<typeof rpc.request.setProvider>[0]['provider']) =>
    rpc.request.setProvider({ provider }),
  saveKey: (provider: Parameters<typeof rpc.request.saveApiKey>[0]['provider'], key: string) =>
    rpc.request.saveApiKey({ provider, key }),
  deleteKey: (provider: Parameters<typeof rpc.request.deleteApiKey>[0]['provider']) =>
    rpc.request.deleteApiKey({ provider }),
}
const MISSING_KEY = /API_KEY is not set/
const formatTokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(value)
const repoName = (root: string | undefined) => root?.split('/').filter(Boolean).at(-1)
const STATUS_LABEL = {
  permission: 'Needs permission',
  running: 'Working',
  idle: 'Idle',
  starting: 'Starting…',
  disconnected: 'Ended',
} as const
const relativeTime = (iso: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString()
}

export default function App() {
  const [ws, dispatchWorkspace] = useReducer(workspace, initialWorkspace)
  const active = ws.active
  const state = (active && ws.sessions[active]) || initialTranscript
  const dispatch = useCallback(
    (action: Action) => {
      if (active) dispatchWorkspace({ type: 'session', key: active, action })
      else if (action.type === 'error' || action.type === 'host_exit')
        setWelcomeErrors((errors) => [...errors, action.message])
    },
    [active],
  )
  const send = (command: HostCommand) => {
    if (active) rpc.send.command({ key: active, command })
  }
  const [welcomeErrors, setWelcomeErrors] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const text = (active && drafts[active]) || ''
  const setText = (value: string) => {
    if (active) setDrafts((current) => ({ ...current, [active]: value }))
  }
  const [panelOpen, setPanelOpen] = useState(true)
  const [panelTab, setPanelTab] = useState<PanelTab>('changes')
  const [opening, setOpening] = useState(false)
  const [confirmBypass, setConfirmBypass] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pending, setPending] = useState<{
    key: string
    prompt?: string
    mode?: PermissionMode
  }>()
  const [slashIndex, setSlashIndex] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const modeMenu = useRef<HTMLDetailsElement>(null)
  const bypassDialog = useRef<HTMLDialogElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const permission = state.permission
  const chooseMode = (mode: PermissionMode) => {
    if (modeMenu.current) modeMenu.current.open = false
    if (mode === state.permissionMode) return
    if (mode === 'bypass') setConfirmBypass(true)
    else send({ v: 1, type: 'set_permission_mode', mode })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure the rendered text after input or session changes.
  useLayoutEffect(() => {
    const input = composer.current
    if (!input) return
    const resize = () => {
      input.style.height = 'auto'
      input.style.height = `${Math.min(input.scrollHeight, 172)}px`
    }
    resize()
    let width = input.clientWidth
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return
      width = input.clientWidth
      resize()
    })
    observer.observe(input)
    return () => observer.disconnect()
  }, [text, state.ready, active])
  useEffect(() => {
    if (confirmBypass) bypassDialog.current?.showModal()
    else bypassDialog.current?.close()
  }, [confirmBypass])
  const startSession = async (
    request: () => Promise<{ opened: boolean; key?: string; error?: string }>,
  ) => {
    setOpening(true)
    try {
      const result = await request()
      if (result.error) dispatch({ v: 1, type: 'error', message: result.error })
      if (result.key) dispatchWorkspace({ type: 'opened', key: result.key })
      return result.key
    } catch (error) {
      dispatch({ v: 1, type: 'error', message: String(error) })
    } finally {
      setOpening(false)
    }
  }
  const openRepository = () =>
    startSession(() =>
      rpc.request.openRepository(undefined, { maxRequestTime: Number.POSITIVE_INFINITY }),
    )
  const repoRoot = state.ready?.repoRoot
  const newSession = () =>
    repoRoot ? startSession(() => rpc.request.newSession({ repoRoot })) : openRepository()
  const resumeSession = (sessionId: string) => {
    if (repoRoot) void startSession(() => rpc.request.resumeSession({ repoRoot, sessionId }))
  }
  const closeSession = (key: string) => {
    dispatchWorkspace({ type: 'close', key })
    void rpc.request.closeSession({ key }).catch(() => undefined)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: dev launch options run once.
  useEffect(() => {
    void (async () => {
      const startup = await rpc.request.startup(undefined, {
        maxRequestTime: Number.POSITIVE_INFINITY,
      })
      if (startup.error) dispatch({ v: 1, type: 'error', message: startup.error })
      if (startup.screen === 'settings') setSettingsOpen(true)
      if (startup.panel) setPanelTab(startup.panel)
      if (startup.key) {
        dispatchWorkspace({ type: 'opened', key: startup.key })
        setPending({ key: startup.key, prompt: startup.prompt, mode: startup.permissionMode })
      }
    })()
  }, [])
  const runningTasks = state.tasks.filter(
    (task) => task.status === 'running' || task.status === 'pending',
  ).length
  useEffect(() => {
    if (!runningTasks) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runningTasks])
  const decide = (decision: PermissionDecision) => {
    if (!permission) return
    send({ v: 1, type: 'permission_reply', requestId: permission.requestId, decision })
    dispatch({ type: 'permission_resolved', requestId: permission.requestId, decision })
  }
  useEffect(() => {
    push = dispatchWorkspace
    return () => {
      push = undefined
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the append-only transcript changes.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [state.items])
  useEffect(() => {
    if (permission) dialog.current?.showModal()
    else {
      dialog.current?.close()
      composer.current?.focus()
    }
  }, [permission])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        permission &&
        !confirmBypass &&
        !settingsOpen &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        const decision = ({ y: 'allow_once', a: 'allow_always', n: 'deny' } as const)[
          event.key.toLowerCase() as 'y' | 'a' | 'n'
        ]
        if (decision) {
          event.preventDefault()
          decide(decision)
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        if (!opening) void openRepository()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        if (!opening && ws.order.length < MAX_SESSIONS) void newSession()
      } else if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
        const key = ws.order[Number(event.key) - 1]
        if (key) {
          event.preventDefault()
          dispatchWorkspace({ type: 'focus', key })
        }
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  const openExternal = async (url: string) => {
    try {
      const result = await rpc.request.openExternal({ url })
      if (!result.opened)
        dispatch({ v: 1, type: 'error', message: 'Could not open link in the system browser.' })
    } catch (error) {
      dispatch({ v: 1, type: 'error', message: String(error) })
    }
  }
  const submitText = (value: string) => {
    if (!value.trim() || state.running || !state.connected) return false
    dispatch({ type: 'user', text: value })
    send({ v: 1, type: 'submit', text: value })
    return true
  }
  const submit = () => {
    if (submitText(text)) setText('')
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: submit the dev prompt once connected.
  useEffect(() => {
    if (!pending || pending.key !== active || !state.connected) return
    if (pending.mode) send({ v: 1, type: 'set_permission_mode', mode: pending.mode })
    if (pending.prompt && !state.running) submitText(pending.prompt)
    setPending(undefined)
  }, [pending, active, state.connected, state.running])
  const slash = slashMatches(text, state.skills)
  const slashOpen = !!slash?.length
  const completeSlash = (index: number) => {
    const skill = slash?.[index]
    if (skill) setText(`/${skill.name} `)
    setSlashIndex(0)
  }
  const blocks = useMemo(() => activityBlocks(state.items), [state.items])
  // Saved sessions of this repository not already open (a resumed one runs under a new id).
  const live = liveSessionIds(ws)
  const savedSessions = state.sessions.filter((session) => !live.has(session.id))
  const atLimit = ws.order.length >= MAX_SESSIONS
  const doneTodos = state.todos.filter((todo) => todo.status === 'completed').length
  const missingKey = state.items.some(
    (item) => item.kind === 'failure' && MISSING_KEY.test(item.text),
  )
  const name = repoName(repoRoot)
  const value = (permission?.input ?? {}) as Record<string, unknown>
  const diff = permission?.preview
    ? permission.preview.split('\n')
    : [
        ...(typeof value.old_string === 'string'
          ? value.old_string.split('\n').map((line) => `-${line}`)
          : []),
        ...(typeof value.new_string === 'string'
          ? value.new_string.split('\n').map((line) => `+${line}`)
          : permission?.toolName === 'Write' && typeof value.content === 'string'
            ? value.content.split('\n').map((line) => `+${line}`)
            : []),
      ]
  return (
    <div className="app">
      <header>
        <strong>{name ?? 'Octonoesis'}</strong>
        <span className="muted">{repoRoot ?? ''}</span>
        <span className="title">
          {state.running ? 'Noe is working…' : state.ready ? sessionTitle(state) : ''}
        </span>
        {state.ready && (
          <details
            ref={modeMenu}
            className={`permission-mode ${state.permissionMode === 'bypass' ? 'warning' : ''}`}
          >
            <summary aria-label="Permission mode">
              {state.permissionMode === 'bypass'
                ? 'Bypass permissions'
                : state.permissionMode === 'accept-edits'
                  ? 'Accept edits'
                  : 'Ask before edits'}{' '}
              ▾
            </summary>
            <div className="mode-options">
              {(['ask', 'accept-edits', 'bypass'] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  aria-pressed={state.permissionMode === mode}
                  disabled={!state.connected}
                  onClick={() => chooseMode(mode)}
                >
                  {mode === 'ask' ? 'Ask' : mode === 'accept-edits' ? 'Accept edits' : 'Bypass'}
                </button>
              ))}
            </div>
          </details>
        )}
        {active && (
          <button
            type="button"
            className="panel-toggle"
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen(!panelOpen)}
            title={panelOpen ? 'Hide the session panel' : 'Show changes, timeline and learning'}
          >
            {panelOpen ? 'Hide panel' : 'Panel'}
          </button>
        )}
      </header>
      {!active ? (
        <main className="welcome">
          <img src={noe} alt="Noe, the Octonoesis mascot" />
          <h1>Octonoesis</h1>
          <p>A local coding agent. Open a repository to start a session.</p>
          <div className="welcome-actions">
            <button
              className="primary open"
              type="button"
              disabled={opening}
              onClick={openRepository}
            >
              {opening ? 'Opening…' : 'Open repository…'} <kbd>⌘O</kbd>
            </button>
            <button className="open" type="button" onClick={() => setSettingsOpen(true)}>
              Provider settings
            </button>
          </div>
          {welcomeErrors.map((message, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: errors are append-only.
            <p className="failure" key={index}>
              {message}
            </p>
          ))}
        </main>
      ) : (
        <div className="workspace">
          <aside>
            <div className="sidebar-heading sessions">
              SESSIONS
              <button
                type="button"
                className="new-session"
                disabled={opening || atLimit}
                onClick={() => void newSession()}
                title={
                  atLimit
                    ? `At most ${MAX_SESSIONS} sessions can run at once`
                    : `Start a new session in ${name ?? 'this repository'} (⌘N)`
                }
              >
                + New
              </button>
            </div>
            <div className="session-list live">
              {ws.order.map((key, index) => {
                const session = ws.sessions[key]
                if (!session) return null
                const status = sessionStatus(session)
                return (
                  <div
                    key={key}
                    className={`session live-session ${key === active ? 'current' : ''}`}
                    aria-current={key === active}
                  >
                    <button
                      type="button"
                      className="session-open"
                      onClick={() => dispatchWorkspace({ type: 'focus', key })}
                      title={index < 9 ? `⌘${index + 1}` : undefined}
                    >
                      <span className={`status-dot ${status}`} aria-hidden="true" />
                      <div>
                        <div className="session-title">{sessionTitle(session)}</div>
                        <div className="muted">
                          {repoName(session.ready?.repoRoot) ?? '…'} · {STATUS_LABEL[status]}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="session-close"
                      aria-label={`Close ${sessionTitle(session)}`}
                      title={
                        session.running ? 'Stop this session and close it' : 'Close this session'
                      }
                      onClick={() => closeSession(key)}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
            <button type="button" onClick={openRepository} disabled={opening || atLimit}>
              Open repository… <kbd>⌘O</kbd>
            </button>
            {savedSessions.length > 0 && (
              <>
                <div className="sidebar-heading saved">SAVED IN {name?.toUpperCase()}</div>
                <div className="session-list">
                  {savedSessions.map((session) => (
                    <button
                      type="button"
                      key={session.id}
                      className="session"
                      disabled={opening || atLimit}
                      title={session.preview}
                      onClick={() => resumeSession(session.id)}
                    >
                      <div className="session-title">{session.preview}</div>
                      <div className="muted">
                        {relativeTime(session.updatedAt)} · {session.messageCount} messages
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
            <button type="button" className="settings-link" onClick={() => setSettingsOpen(true)}>
              Provider settings
            </button>
            <div className="sidebar-bottom">
              <img src={compactNoe} alt="" />
              <div>
                Noe<div className="muted">{state.ready?.model ?? ''}</div>
              </div>
            </div>
          </aside>
          <main className="session-main">
            <div className="conversation" role="log" aria-label="Conversation">
              <div className="conversation-inner">
                {!state.items.length && (
                  <div className="empty">
                    <img src={compactNoe} alt="" />
                    <h2>What are we building?</h2>
                    <p>
                      {state.ready
                        ? `Ask Noe to explore, fix, or build something in ${name}.`
                        : 'Starting the session…'}
                    </p>
                  </div>
                )}
                {blocks.map((block) =>
                  block.kind === 'group' ? (
                    <ActivityGroup key={block.index} tools={block.tools} live={block.live} />
                  ) : block.kind === 'tool' ? (
                    <ToolCard key={block.index} tool={block.tool} />
                  ) : (
                    <div key={block.index} className={`message ${block.item.kind}`}>
                      {block.item.kind === 'assistant' ? (
                        <Markdown text={block.item.text} onOpenExternal={openExternal} />
                      ) : (
                        block.item.text
                      )}
                    </div>
                  ),
                )}
                {missingKey && (
                  <button type="button" onClick={() => setSettingsOpen(true)}>
                    Open Provider settings
                  </button>
                )}
                {state.running && <div className="activity working">● Noe is working…</div>}
                {!state.connected && state.ready && (
                  <button
                    type="button"
                    onClick={() => void newSession()}
                    disabled={opening || atLimit}
                  >
                    Start a new session
                  </button>
                )}
                <div ref={end} />
              </div>
            </div>
            <div className="composer-area">
              {(state.todos.length > 0 || state.tasks.length > 0) && (
                <div className="composer-panels">
                  {state.todos.length > 0 && (
                    <details className="todos" open>
                      <summary>
                        Tasks{' '}
                        <span className="muted">
                          {doneTodos}/{state.todos.length} done
                        </span>
                      </summary>
                      <ul>
                        {state.todos.map((todo) => (
                          <li key={todo.id} className={todo.status}>
                            <span aria-hidden="true">
                              {todo.status === 'completed' ? '✓' : '○'}
                            </span>
                            {todo.content}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {state.tasks.length > 0 && (
                    <div className="task-chips" aria-label="Background tasks">
                      {state.tasks.map((task) => (
                        <span
                          key={task.id}
                          className={`task-chip ${task.status}`}
                          title={task.command ?? task.type}
                        >
                          ● {task.id} {task.type} {task.status}{' '}
                          {Math.max(0, Math.floor(((task.endTime ?? now) - task.startTime) / 1000))}
                          s
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="composer">
                {slashOpen && (
                  <div className="slash-menu" aria-label="Skills">
                    {slash?.map((skill, index) => (
                      <button
                        type="button"
                        key={skill.name}
                        aria-current={index === slashIndex}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          completeSlash(index)
                        }}
                      >
                        <code>/{skill.name}</code>
                        <span className="muted">{skill.description}</span>
                      </button>
                    ))}
                  </div>
                )}
                <textarea
                  ref={composer}
                  rows={2}
                  aria-label="Message Noe"
                  placeholder="Ask Noe to do something…"
                  value={text}
                  disabled={!state.connected || !!permission}
                  onChange={(event) => {
                    setText(event.target.value)
                    setSlashIndex(0)
                  }}
                  onKeyDown={(event) => {
                    if (slashOpen && slash) {
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault()
                        setSlashIndex(
                          (slashIndex + (event.key === 'ArrowDown' ? 1 : -1) + slash.length) %
                            slash.length,
                        )
                        return
                      }
                      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                        event.preventDefault()
                        completeSlash(slashIndex)
                        return
                      }
                    }
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.altKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault()
                      submit()
                    }
                  }}
                />
                <div className="composer-actions">
                  <span className="composer-hint">
                    Enter to send · Shift / Option + Enter for newline
                    {state.skills.length > 0 ? ' · / for skills' : ''}
                  </span>
                  {state.running ? (
                    <button type="button" onClick={() => send({ v: 1, type: 'cancel' })}>
                      ■ Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      disabled={!text.trim() || !state.connected}
                      onClick={submit}
                    >
                      Send ↑
                    </button>
                  )}
                </div>
              </div>
            </div>
          </main>
          {panelOpen && (
            <SidePanel
              tab={panelTab}
              onTab={setPanelTab}
              state={state}
              send={send}
              onDismissRewindError={() => dispatch({ type: 'rewind_dismissed' })}
            />
          )}
        </div>
      )}
      <footer>
        <span>{state.ready ? `Turn ${state.status.turn}` : 'Ready to open a repository'}</span>
        {state.ready && (
          <>
            <span>Context {Math.round(state.status.context * 100)}%</span>
            <span>
              {formatTokens(state.status.inputTokens)} in /{' '}
              {formatTokens(state.status.outputTokens)} out
            </span>
            <span>
              {state.status.priced ? `$${state.status.cost.toFixed(4)}` : 'Cost unavailable'}
            </span>
            {runningTasks > 0 && (
              <span className="activity">
                ● {runningTasks} background {runningTasks === 1 ? 'task' : 'tasks'}
              </span>
            )}
          </>
        )}
        <span className="footer-right">
          {state.ready?.model} {state.ready ? `· v${state.ready.version}` : ''}
        </span>
      </footer>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        requests={settingsRequests}
        hostRunning={state.connected}
      />
      <dialog
        ref={bypassDialog}
        aria-labelledby="bypass-title"
        onCancel={() => setConfirmBypass(false)}
      >
        <h2 id="bypass-title">Bypass permissions?</h2>
        <p>
          Every tool will run without asking for permission, including shell commands and file
          changes. Only enable this for a session you trust. Configured deny rules still apply.
        </p>
        <div className="permission-actions">
          <button type="button" onClick={() => setConfirmBypass(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="bypass-confirm"
            onClick={() => {
              send({ v: 1, type: 'set_permission_mode', mode: 'bypass' })
              setConfirmBypass(false)
            }}
          >
            Enable Bypass
          </button>
        </div>
      </dialog>
      <dialog
        ref={dialog}
        onCancel={(event) => {
          event.preventDefault()
          decide('deny')
        }}
        aria-labelledby="permission-title"
      >
        {permission && (
          <>
            <div className="permission-heading">
              <img src={compactNoe} alt="" />
              <div>
                <h2 id="permission-title">Noe wants to use {permission.toolName}</h2>
                <code>{toolArgument(permission.toolName, permission.input, repoRoot)}</code>
              </div>
            </div>
            {diff.length > 0 ? (
              <div className="diff">
                {diff.map((line, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff line positions are immutable for a request.
                    key={index}
                    className={
                      line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : ''
                    }
                  >
                    {line || ' '}
                  </div>
                ))}
              </div>
            ) : (
              <pre>{JSON.stringify(permission.input, null, 2)}</pre>
            )}
            <div className="permission-actions">
              <p>Session approval applies to this exact tool input.</p>
              <button type="button" onClick={() => decide('deny')}>
                Deny <kbd>N</kbd>
              </button>
              <button type="button" onClick={() => decide('allow_always')}>
                Allow for session <kbd>A</kbd>
              </button>
              <button type="button" className="primary" onClick={() => decide('allow_once')}>
                Allow once <kbd>Y</kbd>
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  )
}
