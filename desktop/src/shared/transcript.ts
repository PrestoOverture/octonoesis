import type { HostMessage, PermissionDecision, PermissionMode } from '../../../src/host/protocol'

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
  status: { turn: number; context: number; cost: number; priced: boolean }
}
export const initialTranscript: Transcript = {
  permissionMode: 'ask',
  items: [],
  running: false,
  connected: false,
  status: { turn: 0, context: 0, cost: 0, priced: false },
}
export type Action =
  | HostMessage
  | { type: 'user'; text: string }
  | { type: 'permission_resolved'; requestId: string; decision: PermissionDecision }
  | { type: 'host_exit'; message: string }

export function primaryArgument(input: unknown): string {
  if (!input || typeof input !== 'object') return String(input ?? '')
  const value = input as Record<string, unknown>
  for (const key of [
    'path',
    'file_path',
    'command',
    'pattern',
    'url',
    'description',
    'prompt',
    'skill',
  ]) {
    if (typeof value[key] === 'string') return value[key].replaceAll('\n', ' ')
  }
  return JSON.stringify(input)
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
        ...append({ kind: 'failure', text: action.message }),
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
          ...state.items.map(
            (item): Item =>
              item.kind === 'tool' && item.status === 'running'
                ? { ...item, status: 'error' }
                : item,
          ),
          ...(action.failure ? [{ kind: 'failure' as const, text: action.failure }] : []),
        ],
      }
    case 'event': {
      const event = action.event
      switch (event.type) {
        case 'text_delta': {
          const last = state.items.at(-1)
          if (last?.kind === 'assistant')
            return {
              ...state,
              items: [...state.items.slice(0, -1), { ...last, text: last.text + event.text }],
            }
          return append({ kind: 'assistant', text: event.text })
        }
        case 'tool_use':
          return append({
            kind: 'tool',
            id: event.id,
            name: event.name,
            argument: primaryArgument(event.input),
            status: 'running',
          })
        case 'tool_done':
          return {
            ...state,
            items: state.items.map((item) =>
              item.kind === 'tool' && item.id === event.id
                ? {
                    ...item,
                    status: event.status,
                    ...(item.name === 'Edit' && event.status === 'done'
                      ? { summary: event.summary }
                      : {}),
                  }
                : item,
            ),
          }
        case 'session_state':
          return {
            ...state,
            status: {
              turn: event.sessionState.turns,
              context: event.sessionState.contextUtilization,
              cost: event.sessionState.costUsd,
              priced: event.priced,
            },
          }
        case 'task_notice':
          return append({ kind: 'notice', text: event.text })
        case 'compact':
          return append({
            kind: 'notice',
            text: `Context compacted: ${event.preTokens} → ${event.postTokens} ${event.postTokens === 1 ? 'token' : 'tokens'}`,
          })
        case 'stream_retry':
          return append({ kind: 'notice', text: `Retry ${event.attempt}: ${event.reason}` })
        case 'rule_recall':
          return append({
            kind: 'learning',
            text: `Recalled ${event.rules.length} ${event.rules.length === 1 ? 'rule' : 'rules'}: ${event.rules.map((rule) => rule.id).join(', ')}`,
          })
        case 'rule_outcome':
          return append({
            kind: 'learning',
            text: `${event.id}: ${event.hit ? 'helped' : 'missed'} · ${event.before.toFixed(2)} → ${event.after.toFixed(2)}`,
          })
        case 'rules_learned':
          return append({
            kind: 'learning',
            text: `Learned ${event.created.length} ${event.created.length === 1 ? 'rule' : 'rules'} · updated ${event.updated}`,
          })
        case 'message_end':
          return state
      }
    }
  }
}
