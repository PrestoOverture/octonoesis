import type { PermissionMode } from '../permissions/confirm'
export type { PermissionMode } from '../permissions/confirm'
import type { RuleFile } from '../memory/rules/types'
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
/** One Write/Edit checkpoint of this session's file history (`octonoesis rewind`). */
export type Checkpoint = {
  seq: number
  ts: string
  tool: 'Write' | 'Edit'
  path: string
  /** The file did not exist before this change; rewinding past it deletes the file. */
  created: boolean
}
export type CheckpointTimeline = {
  entries: Checkpoint[]
  /** Shell commands recorded after `afterSeq` checkpoints; rewind never reverts them. */
  commands: { afterSeq: number; ts: string; command: string }[]
}
/** One file's change since the session first touched it. */
export type FileChange = {
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  /** Unified hunks (no file header); absent for binary or oversized files. */
  patch?: string
  note?: 'binary' | 'too_large'
}
export type RuleSummary = Pick<
  RuleFile,
  'id' | 'status' | 'confidence' | 'hits' | 'misses' | 'scope' | 'advice'
>

export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'
export type HostCommand = { v: 1 } & (
  | { type: 'submit'; text: string }
  | { type: 'cancel' }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | { type: 'permission_reply'; requestId: string; decision: PermissionDecision }
  | { type: 'shutdown' }
  | { type: 'get_changes' }
  | { type: 'get_learning' }
  /** Restore files to before checkpoint `seq`; `force` overrides later outside edits. */
  | { type: 'rewind'; seq: number; force?: boolean }
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
  | ({ type: 'checkpoints' } & CheckpointTimeline)
  | { type: 'changes'; files: FileChange[] }
  | { type: 'learning'; rules: RuleSummary[] }
  | { type: 'rewound'; seq: number; restored: string[] }
  | { type: 'rewind_failed'; seq: number; message: string; conflict: boolean }
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
    case 'get_changes':
    case 'get_learning':
      return value
    case 'rewind':
      if (
        Number.isSafeInteger(value.seq) &&
        value.seq > 0 &&
        (value.force === undefined || typeof value.force === 'boolean')
      )
        return value
      break
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
