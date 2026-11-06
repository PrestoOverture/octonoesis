import type { PermissionMode } from '../permissions/confirm'
export type { PermissionMode } from '../permissions/confirm'
import type { StreamEvent } from '../query'
import type { ExitReason, TaskState } from '../query/types'
import type { Todo } from '../state/todos'

/** A saved session of this repository, as listed in the sidebar. */
export type SessionSummary = {
  id: string
  updatedAt: string
  preview: string
  messageCount: number
}
/** Replayed display history of a resumed session. */
export type HistoryEntry = { type: 'user' | 'task_notice'; text: string } | StreamEvent
export type TaskSummary = Pick<
  TaskState,
  'id' | 'type' | 'status' | 'startTime' | 'endTime' | 'command'
>

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'
export type HostCommand = { v: 1 } & (
  | { type: 'submit'; text: string }
  | { type: 'cancel' }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | { type: 'permission_reply'; requestId: string; decision: PermissionDecision }
  | { type: 'shutdown' }
)
export type HostMessage = { v: 1 } & (
  | { type: 'ready'; sessionId: string; model: string; repoRoot: string; version: string }
  | { type: 'event'; event: StreamEvent }
  | { type: 'permission_mode'; mode: PermissionMode }
  | {
      type: 'permission_request'
      requestId: string
      toolName: string
      input: unknown
      preview?: string
    }
  | { type: 'turn_end'; exitReason: ExitReason; failure?: string }
  | { type: 'history'; resumedFrom: string; updatedAt: string; entries: HistoryEntry[] }
  | { type: 'sessions'; sessions: SessionSummary[] }
  | { type: 'skills'; skills: { name: string; description: string }[] }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'tasks'; tasks: TaskSummary[] }
  | { type: 'error' | 'fatal'; message: string }
)

export function parseHostCommand(line: string): HostCommand {
  const value = JSON.parse(line)
  if (!value || value.v !== 1) throw new Error('Expected protocol version 1')
  switch (value.type) {
    case 'submit':
      if (typeof value.text === 'string' && value.text.trim()) return value
      break
    case 'cancel':
    case 'shutdown':
      return value
    case 'set_permission_mode':
      if (['ask', 'accept-edits', 'bypass'].includes(value.mode)) return value
      break
    case 'permission_reply':
      if (
        typeof value.requestId === 'string' &&
        ['allow_once', 'allow_always', 'deny'].includes(value.decision)
      )
        return value
  }
  throw new Error('Invalid or unknown command')
}
