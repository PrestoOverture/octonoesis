import type { CanonicalMessage } from '../providers/types'
import { summarizeToolResult } from '../query/toolSummary'
import type { StoredSession } from '../state/sessionStore'
import { editLineCounts } from './editSummary'
import type { HistoryEntry, SessionSummary } from './protocol'

const TASK_NOTICE_PREFIX = '<task-notification>'

/** Changed-line summary for an Edit input, matching what the live stream reports. */
export function editSummary(input: unknown): string | undefined {
  const value = input as { old_string?: unknown; new_string?: unknown } | undefined
  if (typeof value?.old_string !== 'string' || typeof value.new_string !== 'string') return
  const { added, removed } = editLineCounts(value.old_string, value.new_string)
  return `+${added} −${removed} lines`
}

function userText(message: Extract<CanonicalMessage, { role: 'user' }>): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/** Replays saved messages as the display events a live session would have streamed. */
export function historyEntries(messages: CanonicalMessage[]): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const text = userText(message)
      entries.push({ type: text.startsWith(TASK_NOTICE_PREFIX) ? 'task_notice' : 'user', text })
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text') entries.push({ type: 'text_delta', text: block.text })
        if (block.type !== 'tool_use') continue
        entries.push(block)
        const result = messages.find(
          (candidate) => candidate.role === 'tool' && candidate.tool_use_id === block.id,
        )
        const blockResult =
          result?.role === 'tool' && Array.isArray(result.content)
            ? result.content.find((part) => part.type === 'tool_result')
            : undefined
        const content =
          result?.role === 'tool' && typeof result.content === 'string'
            ? result.content
            : blockResult?.type === 'tool_result'
              ? blockResult.content
              : ''
        const display = summarizeToolResult(block.name, block.input, {
          ok: !(blockResult?.type === 'tool_result' && blockResult.is_error),
          content,
        })
        entries.push({
          type: 'tool_done',
          id: block.id,
          name: block.name,
          status: display.failed ? 'error' : 'done',
          summary:
            (!display.failed && block.name === 'Edit' && editSummary(block.input)) ||
            display.summary,
        })
      }
      entries.push({
        type: 'message_end',
        usage: { input_tokens: 0, output_tokens: 0 },
        stopReason: 'end_turn',
      })
    }
  }
  return entries
}

function preview(messages: CanonicalMessage[], limit = 80): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = userText(message).replace(/\s+/g, ' ').trim()
    if (!text || text.startsWith(TASK_NOTICE_PREFIX)) continue
    const characters = Array.from(text)
    return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : text
  }
  return '(no messages)'
}

function isStrictPrefix(shorter: CanonicalMessage[], longer: CanonicalMessage[]): boolean {
  if (longer.length <= shorter.length) return false
  return JSON.stringify(longer.slice(0, shorter.length)) === JSON.stringify(shorter)
}

/**
 * Lists saved sessions most recent first. Resuming saves a new session that starts with the
 * old one's messages, so a session another session extends is hidden as superseded.
 */
export function sessionSummaries(sessions: StoredSession[]): SessionSummary[] {
  return sessions
    .filter(
      (session) =>
        session.messages.length > 0 &&
        !sessions.some(
          (other) => other !== session && isStrictPrefix(session.messages, other.messages),
        ),
    )
    .map((session) => ({
      id: session.session_id,
      updatedAt: session.updated_at,
      preview: preview(session.messages),
      messageCount: session.messages.length,
    }))
}
