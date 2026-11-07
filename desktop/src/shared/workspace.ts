import { type Action, type Transcript, initialTranscript, transcript } from './transcript'

/** Every live session the window holds; each key is one engine host process. */
export type Workspace = {
  order: string[]
  sessions: Record<string, Transcript>
  active?: string
  /** Closed keys: late messages from their stopping host are dropped. */
  closed: string[]
}
export const initialWorkspace: Workspace = { order: [], sessions: {}, closed: [] }
export type WorkspaceAction =
  | { type: 'opened'; key: string }
  | { type: 'focus'; key: string }
  | { type: 'close'; key: string }
  | { type: 'session'; key: string; action: Action }

export const MAX_SESSIONS = 6

export function workspace(state: Workspace, action: WorkspaceAction): Workspace {
  switch (action.type) {
    case 'opened': {
      const opened = add(state, action.key)
      return opened.sessions[action.key] ? { ...opened, active: action.key } : opened
    }
    case 'focus':
      return state.sessions[action.key] ? { ...state, active: action.key } : state
    case 'close': {
      if (!state.sessions[action.key]) return state
      const index = state.order.indexOf(action.key)
      const order = state.order.filter((key) => key !== action.key)
      const { [action.key]: _closed, ...sessions } = state.sessions
      return {
        order,
        sessions,
        closed: [...state.closed, action.key],
        active:
          state.active === action.key
            ? (order[Math.min(index, order.length - 1)] ?? undefined)
            : state.active,
      }
    }
    case 'session': {
      // A host's first lines can arrive before its open request resolves.
      const next = add(state, action.key)
      const current = next.sessions[action.key]
      if (!current) return state
      return {
        ...next,
        active: next.active ?? action.key,
        sessions: { ...next.sessions, [action.key]: transcript(current, action.action) },
      }
    }
  }
}

function add(state: Workspace, key: string): Workspace {
  if (state.sessions[key] || state.closed.includes(key)) return state
  return {
    ...state,
    order: [...state.order, key],
    sessions: { ...state.sessions, [key]: initialTranscript },
  }
}

export type SessionStatus = 'permission' | 'running' | 'idle' | 'starting' | 'disconnected'

export function sessionStatus(session: Transcript): SessionStatus {
  if (session.permission) return 'permission'
  if (session.running) return 'running'
  if (session.connected) return 'idle'
  return session.ready ? 'disconnected' : 'starting'
}

/** Sidebar title: the first prompt, else the saved preview it resumed, else a placeholder. */
export function sessionTitle(session: Transcript): string {
  const first = session.items.find((item) => item.kind === 'user')
  const text = first?.kind === 'user' ? first.text.replace(/\s+/g, ' ').trim() : ''
  if (text) return text.length > 60 ? `${text.slice(0, 59)}…` : text
  const resumed = session.sessions.find((saved) => saved.id === session.resumedFrom)
  if (resumed) return resumed.preview
  return session.resumedFrom ? 'Resumed session' : 'New session'
}

/** Saved session ids already shown as a live session (its own id or the one it resumed). */
export function liveSessionIds(state: Workspace): Set<string> {
  const ids = new Set<string>()
  for (const session of Object.values(state.sessions)) {
    if (session.ready) ids.add(session.ready.sessionId)
    if (session.resumedFrom) ids.add(session.resumedFrom)
  }
  return ids
}
