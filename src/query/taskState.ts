import type { CanonicalMessage, ContentBlock } from '../providers/types'

const OPEN = '<octo-task-state>'
const CLOSE = '</octo-task-state>'

export interface CompactTaskState {
  version: 1
  userRequests: string[]
  toolResultLiterals?: string[]
  evidence: { toolUseId: string; tool: string; input: unknown; outcome: 'observed' | 'error' }[]
}

// Protect opaque UUID identifiers independently of summary prose. Keep the most recent 32
// (each at most 101 characters including its prefix), not arbitrary tool output.
export function extractToolResultLiterals(body: string): string[] {
  const literals = new Set<string>()
  const pattern =
    /\b(?:[a-z][a-z0-9_.-]{0,63}[_-])?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi
  for (const match of body.matchAll(pattern)) {
    literals.delete(match[0])
    literals.add(match[0])
    if (literals.size > 32) literals.delete(literals.values().next().value as string)
  }
  return [...literals]
}

function text(message: CanonicalMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
}

/** Keep exact requests separately from model prose; carry them across repeated compactions. */
export function buildCompactTaskState(messages: CanonicalMessage[]): CompactTaskState {
  const userRequests = new Set<string>()
  const toolResultLiterals = new Set<string>()
  const retain = (body: string) => {
    for (const literal of extractToolResultLiterals(body)) {
      toolResultLiterals.delete(literal)
      toolResultLiterals.add(literal)
      if (toolResultLiterals.size > 32)
        toolResultLiterals.delete(toolResultLiterals.values().next().value as string)
    }
  }
  const evidence = new Map<string, CompactTaskState['evidence'][number]>()
  const calls = new Map<string, Extract<ContentBlock, { type: 'tool_use' }>>()
  for (const message of messages) {
    const body = text(message)
    if (message.role === 'user' && body.startsWith('<octo-compact-summary>')) {
      const start = body.indexOf(OPEN)
      const end = body.indexOf(CLOSE, start)
      if (start !== -1 && end !== -1) {
        try {
          const previous = JSON.parse(body.slice(start + OPEN.length, end)) as CompactTaskState
          if (previous.version === 1 && Array.isArray(previous.userRequests)) {
            for (const request of previous.userRequests)
              if (typeof request === 'string') userRequests.add(request)
          }
          if (previous.version === 1 && Array.isArray(previous.toolResultLiterals)) {
            for (const literal of previous.toolResultLiterals)
              if (typeof literal === 'string') retain(literal)
          }
          if (Array.isArray(previous.evidence)) {
            for (const item of previous.evidence)
              if (typeof item.toolUseId === 'string') evidence.set(item.toolUseId, item)
          }
        } catch {
          /* Old summaries without a valid state remain available to the summarizer. */
        }
      }
    } else if (message.role === 'user' && !body.startsWith('<task-notification>')) {
      userRequests.add(body)
    }
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'tool_use') calls.set(block.id, block)
    } else if (message.role === 'tool') {
      if (typeof message.content === 'string') retain(message.content)
      else
        for (const block of message.content) {
          if (block.type === 'text') retain(block.text)
          else if (block.type === 'tool_result') retain(block.content)
        }
      const call = calls.get(message.tool_use_id)
      if (call)
        evidence.set(call.id, {
          toolUseId: call.id,
          tool: call.name,
          input: call.input,
          outcome:
            typeof message.content !== 'string' &&
            message.content.some((block) => block.type === 'tool_result' && block.is_error)
              ? 'error'
              : 'observed',
        })
    }
  }
  return {
    version: 1,
    ...(toolResultLiterals.size ? { toolResultLiterals: [...toolResultLiterals] } : {}),
    userRequests: [...userRequests],
    evidence: [...evidence.values()].slice(-12),
  }
}

export function renderCompactTaskState(state: CompactTaskState): string {
  return `${OPEN}\n${JSON.stringify(state).replaceAll('<', '\\u003c')}\n${CLOSE}`
}
