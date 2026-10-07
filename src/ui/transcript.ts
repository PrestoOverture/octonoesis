import type { CanonicalMessage, StreamEvent } from '../query'
import type { BannerSnapshot } from './StartupBanner'
import { stableMarkdownLength } from './markdown'

export type DisplayItem =
  | ({ kind: 'banner' } & BannerSnapshot)
  | { kind: 'resume' | 'user' | 'task_notice'; text: string }
  | { kind: 'assistant' | 'stats' | 'failure'; text: string; verbatim: boolean; header: boolean }
  | { kind: 'tool'; id: string; name: string; args: string; status: 'done' | 'error' }
  | { kind: 'compact'; preTokens: number; postTokens: number; durationMs: number }

export interface RunningTool {
  id: string
  name: string
  args: string
}
export interface TranscriptState {
  transcript: DisplayItem[]
  pending: string
  header: boolean
  running: RunningTool[]
}
export type TranscriptEvent =
  | StreamEvent
  | { type: 'banner'; snapshot: BannerSnapshot }
  | { type: 'user'; text: string }
  | { type: 'stats' | 'failure'; text: string }
  | { type: 'end' }

function append(state: TranscriptState, item: DisplayItem): TranscriptState {
  return { ...state, transcript: [...state.transcript, item] }
}
function flush(state: TranscriptState): TranscriptState {
  if (!state.pending) return state
  return {
    ...append(state, {
      kind: 'assistant',
      text: state.pending,
      verbatim: false,
      header: state.header,
    }),
    pending: '',
    header: false,
  }
}

/** Display-only state: committed objects retain identity and never depend on model history. */
export function transcriptReducer(state: TranscriptState, event: TranscriptEvent): TranscriptState {
  switch (event.type) {
    case 'banner':
      if (state.transcript.some((item) => item.kind === 'banner')) return state
      // Append, never prepend: <Static> renders items.slice(renderedCount), so reordering
      // committed items would duplicate one and drop another.
      return append(state, { kind: 'banner', ...event.snapshot })
    case 'text_delta': {
      const pending = state.pending + event.text
      const length = stableMarkdownLength(pending)
      if (!length) return { ...state, pending }
      return {
        ...append(state, {
          kind: 'assistant',
          text: pending.slice(0, length),
          verbatim: false,
          header: state.header,
        }),
        pending: pending.slice(length),
        header: false,
      }
    }
    case 'tool_use':
      return {
        ...flush(state),
        header: true,
        running: [
          ...state.running,
          { id: event.id, name: event.name, args: event.input ? JSON.stringify(event.input) : '' },
        ],
      }
    case 'tool_done': {
      const tool = state.running.find((tool) => tool.id === event.id)
      if (!tool) return state
      return {
        ...append(state, { kind: 'tool', ...tool, status: event.status }),
        running: state.running.filter((tool) => tool.id !== event.id),
      }
    }
    case 'compact':
      return {
        ...append(flush(state), {
          kind: 'compact',
          preTokens: event.preTokens,
          postTokens: event.postTokens,
          durationMs: event.durationMs,
        }),
        header: true,
      }
    case 'user':
    case 'task_notice':
      return { ...append(flush(state), { kind: event.type, text: event.text }), header: true }
    case 'stats':
    case 'failure':
      return {
        ...append(flush(state), {
          kind: event.type,
          text: event.text,
          verbatim: true,
          header: true,
        }),
        header: true,
      }
    case 'end': {
      let next = flush(state)
      // Cancellation can end the generator before tool_done arrives.
      for (const tool of next.running)
        next = append(next, { kind: 'tool', ...tool, status: 'error' })
      return { ...next, running: [], header: true }
    }
    default:
      return state
  }
}

export function seedTranscript(
  messages: CanonicalMessage[] = [],
  resume?: { sessionId: string; messageCount: number; updatedAt: string },
): TranscriptState {
  let state: TranscriptState = { transcript: [], pending: '', header: true, running: [] }
  if (resume)
    state = append(state, {
      kind: 'resume',
      text: `Resumed ${resume.sessionId.slice(0, 8)}: ${resume.messageCount} messages, last active ${resume.updatedAt}`,
    })
  for (const message of messages) {
    if (message.role === 'user') {
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
      state = transcriptReducer(state, {
        type: text.startsWith('<task-notification>') ? 'task_notice' : 'user',
        text,
      })
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text')
          state = transcriptReducer(state, { type: 'text_delta', text: block.text })
        if (block.type === 'tool_use') {
          state = transcriptReducer(state, block)
          const result = messages.find(
            (candidate) => candidate.role === 'tool' && candidate.tool_use_id === block.id,
          )
          state = transcriptReducer(state, {
            type: 'tool_done',
            id: block.id,
            name: block.name,
            status:
              result?.role === 'tool' &&
              typeof result.content === 'string' &&
              result.content.includes('"error":')
                ? 'error'
                : 'done',
          })
        }
      }
      state = transcriptReducer(state, { type: 'end' })
    }
  }
  return state
}
