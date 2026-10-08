import { expect, test } from 'bun:test'
import type { CanonicalMessage } from '../../../src/query'
import { type TranscriptEvent, seedTranscript, transcriptReducer } from '../../../src/ui/transcript'

test('split markdown, three same-name tools, notices and end form an immutable display log', () => {
  let state = seedTranscript()
  const events: TranscriptEvent[] = [
    { type: 'user', text: 'go' },
    { type: 'text_delta', text: '**hel' },
    { type: 'text_delta', text: 'lo**\n\nnext `to' },
    { type: 'text_delta', text: 'ken`' },
    ...[1, 2, 3].map((id) => ({
      type: 'tool_use' as const,
      id: String(id),
      name: 'Read',
      input: { path: `${id}.txt` },
    })),
    { type: 'tool_done', id: '2', name: 'Read', status: 'error' },
    { type: 'tool_done', id: '1', name: 'Read', status: 'done' },
    { type: 'tool_done', id: '3', name: 'Read', status: 'done' },
    { type: 'compact', preTokens: 200, postTokens: 20, durationMs: 1 },
    { type: 'task_notice', text: 'notice' },
    { type: 'text_delta', text: 'final tail' },
    { type: 'end' },
  ]
  for (const event of events) {
    const previous = state
    const serialized = JSON.stringify(previous)
    Object.freeze(previous.transcript)
    for (const item of previous.transcript) Object.freeze(item)
    state = transcriptReducer(state, event)
    expect(JSON.stringify(previous)).toBe(serialized)
    expect(state.transcript.length >= previous.transcript.length).toBe(true)
    previous.transcript.forEach((item, index) => expect(state.transcript[index]).toBe(item))
    if (event.type === 'tool_use') expect(state.pending).toBe('')
    if (event.type === 'tool_done' && event.id === '2')
      expect(state.running.map((tool) => tool.id)).toEqual(['1', '3'])
  }
  expect(state.pending).toBe('')
  expect(state.running).toEqual([])
  expect(state.transcript).toEqual([
    { kind: 'user', text: 'go', spacer: true },
    { kind: 'assistant', text: '**hello**\n\n', verbatim: false, header: true },
    { kind: 'assistant', text: 'next `token`', verbatim: false, header: false },
    { kind: 'tool', id: '2', name: 'Read', args: '2.txt', status: 'error' },
    { kind: 'tool', id: '1', name: 'Read', args: '1.txt', status: 'done' },
    { kind: 'tool', id: '3', name: 'Read', args: '3.txt', status: 'done' },
    { kind: 'compact', preTokens: 200, postTokens: 20, durationMs: 1 },
    { kind: 'task_notice', text: 'notice' },
    { kind: 'assistant', text: 'final tail', verbatim: false, header: true },
  ])
})

test('seeding copies history into display items; shrinking model history cannot change the log', () => {
  const messages: CanonicalMessage[] = [
    { role: 'user', content: 'original prompt' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'original reply' },
        { type: 'tool_use', id: 'a', name: 'Read', input: { path: 'a' } },
      ],
    },
    {
      role: 'tool',
      tool_use_id: 'a',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '{"error":"missing"}', is_error: true },
        { type: 'text', text: '{"error":"missing"}' },
      ],
    },
  ]
  let state = seedTranscript(messages, {
    sessionId: 'resume-id',
    messageCount: 3,
    updatedAt: 'today',
  })
  const before = JSON.stringify(state.transcript)
  messages.splice(0, messages.length, { role: 'user', content: 'short summary' })
  expect(JSON.stringify(state.transcript)).toBe(before)
  state = transcriptReducer(state, { type: 'text_delta', text: 'next reply' })
  state = transcriptReducer(state, { type: 'end' })
  expect(state.transcript.at(-1)).toEqual({
    kind: 'assistant',
    text: 'next reply',
    verbatim: false,
    header: true,
  })
  expect(state.transcript.filter((item) => item.kind === 'resume').length).toBe(1)
  expect(state.transcript.find((item) => item.kind === 'tool')?.status).toBe('error')
})

test('unclosed fences stay pending and flush intact at tool boundaries and end', () => {
  const fence = `\`\`\`ts\n${'const value = 1\n'.repeat(200)}`
  let state = transcriptReducer(seedTranscript(), { type: 'text_delta', text: fence })
  expect(state.transcript).toEqual([])
  expect(state.pending).toBe(fence)
  state = transcriptReducer(state, { type: 'tool_use', id: 'a', name: 'Read', input: {} })
  expect(state.transcript[0]).toEqual({
    kind: 'assistant',
    text: fence,
    verbatim: false,
    header: true,
  })
  state = transcriptReducer(state, { type: 'text_delta', text: fence })
  state = transcriptReducer(state, { type: 'end' })
  expect(state.transcript[1]).toEqual({
    kind: 'assistant',
    text: fence,
    verbatim: false,
    header: true,
  })
  expect(state.pending).toBe('')
})
