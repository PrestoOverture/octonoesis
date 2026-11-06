import { Electroview } from 'electrobun/view'
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { HostCommand, PermissionDecision, PermissionMode } from '../../../src/host/protocol'
import { Markdown } from '../shared/Markdown'
import type { DesktopRPC } from '../shared/rpc'
import { type Action, initialTranscript, primaryArgument, transcript } from '../shared/transcript'
import compactNoe from './assets/noe-compact.svg'
import noe from './assets/noe-f11.svg'

let push: ((action: Action) => void) | undefined
const rpc = Electroview.defineRPC<DesktopRPC>({
  maxRequestTime: 15000,
  handlers: {
    requests: {},
    messages: {
      host: (message) => push?.(message),
      hostExit: ({ message }) => push?.({ type: 'host_exit', message }),
    },
  },
})
new Electroview({ rpc })
const send = (command: HostCommand) => rpc.send.command(command)

export default function App() {
  const [state, dispatch] = useReducer(transcript, initialTranscript)
  const [text, setText] = useState('')
  const [opening, setOpening] = useState(false)
  const [confirmBypass, setConfirmBypass] = useState(false)
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
  }, [text, state.ready])
  useEffect(() => {
    if (confirmBypass) bypassDialog.current?.showModal()
    else bypassDialog.current?.close()
  }, [confirmBypass])
  const openRepository = async () => {
    setOpening(true)
    try {
      const result = await rpc.request.openRepository(undefined, {
        maxRequestTime: Number.POSITIVE_INFINITY,
      })
      if (result.error) dispatch({ v: 1, type: 'error', message: result.error })
    } catch (error) {
      dispatch({ type: 'host_exit', message: String(error) })
    } finally {
      setOpening(false)
    }
  }
  const decide = (decision: PermissionDecision) => {
    if (!permission) return
    send({ v: 1, type: 'permission_reply', requestId: permission.requestId, decision })
    dispatch({ type: 'permission_resolved', requestId: permission.requestId, decision })
  }
  useEffect(() => {
    push = dispatch
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
      if (permission && !confirmBypass && !event.metaKey && !event.ctrlKey && !event.altKey) {
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
  const submit = () => {
    if (!text.trim() || state.running || !state.connected) return
    dispatch({ type: 'user', text })
    send({ v: 1, type: 'submit', text })
    setText('')
  }
  const repoName = state.ready?.repoRoot.split('/').filter(Boolean).at(-1)
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
        <strong>{repoName ?? 'Octonoesis'}</strong>
        <span className="muted">{state.ready ? state.ready.repoRoot : ''}</span>
        <span className="title">
          {state.running ? 'Noe is working…' : state.ready ? 'Session' : ''}
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
      </header>
      {!state.ready ? (
        <main className="welcome">
          <img src={noe} alt="Noe, the Octonoesis mascot" />
          <h1>Octonoesis</h1>
          <p>A local coding agent. Open a repository to start a session.</p>
          <button
            className="primary open"
            type="button"
            disabled={opening}
            onClick={openRepository}
          >
            {opening ? 'Opening…' : 'Open repository…'} <kbd>⌘O</kbd>
          </button>
          {state.items.map(
            (item, index) =>
              item.kind === 'failure' && (
                // biome-ignore lint/suspicious/noArrayIndexKey: transcript entries are append-only.
                <p className="failure" key={index}>
                  {item.text}
                </p>
              ),
          )}
        </main>
      ) : (
        <div className="workspace">
          <aside>
            <div className="sidebar-heading">REPOSITORY</div>
            <strong>{repoName}</strong>
            <div className="repo-path">{state.ready.repoRoot}</div>
            <button type="button" onClick={openRepository} disabled={opening}>
              Open repository…
            </button>
            <div className="sidebar-heading sessions">SESSIONS</div>
            <div className="session">
              <span className="activity">●</span> Current session
            </div>
            <div className="sidebar-bottom">
              <img src={compactNoe} alt="" />
              <div>
                Noe<div className="muted">{state.ready.model}</div>
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
                    <p>Ask Noe to explore, fix, or build something in {repoName}.</p>
                  </div>
                )}
                {state.items.map((item, index) =>
                  item.kind === 'tool' ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: transcript entries are append-only.
                    <div className={`tool ${item.status}`} key={index}>
                      <span>
                        {item.status === 'running' ? '◌' : item.status === 'done' ? '✓' : '×'}
                      </span>
                      <strong>{item.name}</strong>
                      <code title={item.argument}>{item.argument}</code>
                      <span>{item.summary ?? item.status}</span>
                    </div>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: transcript entries are append-only.
                    <div key={index} className={`message ${item.kind}`}>
                      {item.kind === 'assistant' ? (
                        <Markdown text={item.text} onOpenExternal={openExternal} />
                      ) : (
                        item.text
                      )}
                    </div>
                  ),
                )}
                {state.running && <div className="activity working">● Noe is working…</div>}
                {!state.connected && (
                  <button type="button" onClick={openRepository} disabled={opening}>
                    Reopen repository…
                  </button>
                )}
                <div ref={end} />
              </div>
            </div>
            <div className="composer-area">
              <div className="composer">
                <textarea
                  ref={composer}
                  rows={2}
                  aria-label="Message Noe"
                  placeholder="Ask Noe to do something…"
                  value={text}
                  disabled={!state.connected || !!permission}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
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
        </div>
      )}
      <footer>
        <span>{state.ready ? `Turn ${state.status.turn}` : 'Ready to open a repository'}</span>
        {state.ready && (
          <>
            <span>Context {Math.round(state.status.context * 100)}%</span>
            <span>
              {state.status.priced ? `$${state.status.cost.toFixed(4)}` : 'Cost unavailable'}
            </span>
          </>
        )}
        <span className="footer-right">
          {state.ready?.model} {state.ready ? `· v${state.ready.version}` : ''}
        </span>
      </footer>
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
                <code>{primaryArgument(permission.input)}</code>
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
