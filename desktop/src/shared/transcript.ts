import type {
  CheckpointTimeline,
  FileChange,
  HistoryEntry,
  HostMessage,
  PermissionDecision,
  PermissionMode,
  RuleSummary,
  SessionSummary,
  TaskSummary,
} from '../../../src/host/protocol'
import { primaryArg } from '../../../src/query/toolSummary'
import type { Todo } from '../../../src/state/todos'

export type Item =
  | { kind: 'user' | 'assistant' | 'learning' | 'notice' | 'failure'; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      argument: string
      status: 'running' | 'done' | 'error'
      summary?: string
    }
export type Permission = Extract<HostMessage, { type: 'permission_request' }>
export type Transcript = {
  items: Item[]
  ready?: Extract<HostMessage, { type: 'ready' }>
  permission?: Permission
  permissionMode: PermissionMode
  running: boolean
  connected: boolean
  status: {
    turn: number
    context: number
    cost: number
    priced: boolean
    inputTokens: number
    outputTokens: number
  }
  sessions: SessionSummary[]
  resumedFrom?: string
  skills: { name: string; description: string }[]
  todos: Todo[]
  tasks: TaskSummary[]
  checkpoints: CheckpointTimeline
  /** Checkpoints whose changes a rewind has undone. */
  reverted: number[]
  /** Latest `get_changes` / `get_learning` answers; undefined until first asked. */
  changes?: FileChange[]
  rules?: RuleSummary[]
  rewindError?: Extract<HostMessage, { type: 'rewind_failed' }>
}
export const initialTranscript: Transcript = {
  permissionMode: 'ask',
  items: [],
  running: false,
  connected: false,
  status: { turn: 0, context: 0, cost: 0, priced: false, inputTokens: 0, outputTokens: 0 },
  sessions: [],
  skills: [],
  todos: [],
  tasks: [],
  checkpoints: { entries: [], commands: [] },
  reverted: [],
}
export type Action =
  | HostMessage
  | { type: 'user'; text: string }
  | { type: 'permission_resolved'; requestId: string; decision: PermissionDecision }
  | { type: 'host_exit'; message: string }
  | { type: 'rewind_dismissed' }

/** The tool's main argument as the TUI shows it: one line, repo-relative paths. */
export function toolArgument(name: string, input: unknown, repoRoot?: string): string {
  const argument = primaryArg(name, input, repoRoot)
  return argument || (name === 'TodoWrite' ? '' : JSON.stringify(input ?? null))
}

const TASK_NOTICE_PREFIX = '<task-notification>'
const tag = (source: string, name: string) =>
  source.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1]?.trim()

/** Compact label for a synthetic `<task-notification>` message, as in the TUI. */
export function taskNoticeLabel(text: string): string {
  const generic = 'Task › background task update'
  if (!text.startsWith(TASK_NOTICE_PREFIX)) return text.trim() ? text : generic
  const taskId = tag(text, 'task_id')
  const status = tag(text, 'status')
  const summary = tag(text, 'summary')?.replace(/\s+/g, ' ')
  if (!taskId || !status || !summary) return generic
  return `Task › ${taskId} ${status}: ${summary.length > 80 ? `${summary.slice(0, 79)}…` : summary}`
}

function event(state: Transcript, entry: HistoryEntry): Transcript {
  const append = (item: Item) => ({ ...state, items: [...state.items, item] })
  const repoRoot = state.ready?.repoRoot
  switch (entry.type) {
    case 'user':
      return append({ kind: 'user', text: entry.text })
    case 'text_delta': {
      const last = state.items.at(-1)
      if (last?.kind === 'assistant')
        return {
          ...state,
          items: [...state.items.slice(0, -1), { ...last, text: last.text + entry.text }],
        }
      return append({ kind: 'assistant', text: entry.text })
    }
    case 'tool_use':
      return append({
        kind: 'tool',
        id: entry.id,
        name: entry.name,
        argument: toolArgument(entry.name, entry.input, repoRoot),
        status: 'running',
      })
    case 'tool_done':
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === 'tool' && item.id === entry.id
            ? {
                ...item,
                status: entry.status,
                ...(entry.summary ? { summary: entry.summary } : {}),
              }
            : item,
        ),
      }
    case 'session_state':
      return {
        ...state,
        status: {
          turn: entry.sessionState.turns,
          context: entry.sessionState.contextUtilization,
          cost: entry.sessionState.costUsd,
          priced: entry.priced,
          inputTokens: entry.sessionState.usage.input_tokens,
          outputTokens: entry.sessionState.usage.output_tokens,
        },
      }
    case 'task_notice':
      return append({ kind: 'notice', text: taskNoticeLabel(entry.text) })
    case 'compact':
      return append({
        kind: 'notice',
        text: `Context compacted: ${entry.preTokens} → ${entry.postTokens} ${entry.postTokens === 1 ? 'token' : 'tokens'}`,
      })
    case 'stream_retry': {
      // The provider replays the whole reply: drop its partial text and unstarted tools.
      const items = state.items.filter(
        (item, index) =>
          !(item.kind === 'tool' && item.status === 'running') &&
          !(index === state.items.length - 1 && item.kind === 'assistant'),
      )
      return {
        ...state,
        items: [
          ...items,
          { kind: 'notice', text: `Connection lost, retrying (${entry.attempt}/2)` },
        ],
      }
    }
    case 'rule_recall':
      if (!entry.rules.length) return state
      return append({
        kind: 'learning',
        text: `Recalled ${entry.rules.length} ${entry.rules.length === 1 ? 'rule' : 'rules'}: ${entry.rules.map((rule) => rule.id).join(', ')}`,
      })
    case 'rule_outcome':
      return append({
        kind: 'learning',
        text: `${entry.id}: ${entry.hit ? 'helped' : 'missed'} · ${entry.before.toFixed(2)} → ${entry.after.toFixed(2)}`,
      })
    case 'rules_learned':
      if (!entry.created.length && !entry.updated) return state
      return append({
        kind: 'learning',
        text: entry.created.length
          ? `Learned ${entry.created.length} ${entry.created.length === 1 ? 'rule' : 'rules'} · updated ${entry.updated}`
          : `Strengthened ${entry.updated} ${entry.updated === 1 ? 'rule' : 'rules'}`,
      })
    case 'message_end':
      return state
  }
}

/** Running tools end as failures when their turn ends without a tool_done (cancel). */
function settleRunning(items: Item[]): Item[] {
  return items.map((item) =>
    item.kind === 'tool' && item.status === 'running'
      ? { ...item, status: 'error', summary: 'cancelled' }
      : item,
  )
}

export function transcript(state: Transcript, action: Action): Transcript {
  const append = (item: Item) => ({ ...state, items: [...state.items, item] })
  switch (action.type) {
    case 'ready':
      return { ...initialTranscript, ready: action, connected: true }
    case 'permission_mode':
      return { ...state, permissionMode: action.mode }
    case 'user':
      return { ...append({ kind: 'user', text: action.text }), running: true }
    case 'permission_request':
      return { ...state, permission: action }
    case 'permission_resolved':
      return action.requestId === state.permission?.requestId
        ? { ...state, permission: undefined }
        : state
    case 'host_exit':
    case 'fatal':
      return {
        ...state,
        items: [...settleRunning(state.items), { kind: 'failure', text: action.message }],
        running: false,
        connected: false,
        permission: undefined,
      }
    case 'error':
      return append({ kind: 'failure', text: action.message })
    case 'turn_end':
      return {
        ...state,
        running: false,
        permission: undefined,
        items: [
          ...settleRunning(state.items),
          ...(action.failure ? [{ kind: 'failure' as const, text: action.failure }] : []),
        ],
      }
    case 'history': {
      const replayed = action.entries.reduce(event, state)
      return {
        ...replayed,
        items: [
          ...settleRunning(replayed.items),
          {
            kind: 'notice',
            text: `Resumed session from ${new Date(action.updatedAt).toLocaleString()}`,
          },
        ],
        resumedFrom: action.resumedFrom,
      }
    }
    case 'sessions':
      return { ...state, sessions: action.sessions }
    case 'skills':
      return { ...state, skills: action.skills }
    case 'todos':
      return { ...state, todos: action.todos }
    case 'tasks':
      return { ...state, tasks: action.tasks }
    case 'checkpoints':
      return { ...state, checkpoints: { entries: action.entries, commands: action.commands } }
    case 'changes':
      return { ...state, changes: action.files }
    case 'learning':
      return { ...state, rules: action.rules }
    case 'rewound': {
      const undone = state.checkpoints.entries
        .map((entry) => entry.seq)
        .filter((seq) => seq >= action.seq && !state.reverted.includes(seq))
      const count = action.restored.length
      return {
        ...append({
          kind: 'notice',
          text: `Rewound ${count} ${count === 1 ? 'file' : 'files'} to before change #${action.seq}`,
        }),
        reverted: [...state.reverted, ...undone],
        rewindError: undefined,
      }
    }
    case 'rewind_failed':
      return { ...state, rewindError: action }
    case 'rewind_dismissed':
      return { ...state, rewindError: undefined }
    case 'event':
      return event(state, action.event)
  }
}

/** Skills whose `/name` completes the composer's leading slash command. */
export function slashMatches(
  text: string,
  skills: Transcript['skills'],
): Transcript['skills'] | undefined {
  const match = text.match(/^\/([a-z0-9-]*)$/)
  if (!match) return
  return skills.filter((skill) => skill.name.startsWith(match[1] ?? '')).slice(0, 8)
}
