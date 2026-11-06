import { expect, test } from 'bun:test'
import { editLineCounts } from '../../../src/host/editSummary'
import { initialTranscript, transcript } from './transcript'

test('assistant deltas concatenate, tool cards transition running to done and error', () => {
  let state = transcript(initialTranscript, { type: 'user', text: 'hello' })
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: { type: 'text_delta', text: '<b>hello' },
  })
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: { type: 'text_delta', text: ' world</b>' },
  })
  expect(state.items).toEqual([
    { kind: 'user', text: 'hello' },
    { kind: 'assistant', text: '<b>hello world</b>' },
  ])
  for (const status of ['done', 'error'] as const) {
    state = transcript(state, {
      v: 1,
      type: 'event',
      event: { type: 'tool_use', id: status, name: 'Read', input: { path: 'src/main.ts' } },
    })
    expect(state.items.at(-1)).toMatchObject({
      kind: 'tool',
      status: 'running',
      argument: 'src/main.ts',
    })
    state = transcript(state, {
      v: 1,
      type: 'event',
      event: { type: 'tool_done', id: status, name: 'Read', status },
    })
    expect(state.items.at(-1)).toMatchObject({ id: status, status })
  }
  expect(initialTranscript.items).toEqual([])
})

test('permission opens then resolves only for the matching request; turn end clears it', () => {
  const request = {
    v: 1,
    type: 'permission_request',
    requestId: 'p1',
    toolName: 'Edit',
    input: { path: 'a' },
  } as const
  const state = transcript(initialTranscript, request)
  expect(state.permission).toEqual(request)
  expect(
    transcript(state, { type: 'permission_resolved', requestId: 'other', decision: 'deny' })
      .permission,
  ).toEqual(request)
  for (const decision of ['allow_once', 'allow_always', 'deny'] as const) {
    expect(
      transcript(state, { type: 'permission_resolved', requestId: 'p1', decision }).permission,
    ).toBeUndefined()
  }
  expect(
    transcript(state, { v: 1, type: 'turn_end', exitReason: 'user_cancel' }).permission,
  ).toBeUndefined()
})

test('failure items appear on failed turns, protocol errors and host exits', () => {
  let state = transcript(initialTranscript, { type: 'user', text: 'start' })
  state = transcript(state, {
    v: 1,
    type: 'turn_end',
    exitReason: 'fatal_error',
    failure: 'Provider failed',
  })
  expect(state.running).toBe(false)
  expect(state.items.at(-1)).toEqual({ kind: 'failure', text: 'Provider failed' })
  state = transcript(state, { v: 1, type: 'error', message: 'Bad command' })
  expect(state.items.at(-1)).toEqual({ kind: 'failure', text: 'Bad command' })
  state = transcript(state, { type: 'host_exit', message: 'Engine exited' })
  expect(state.connected).toBe(false)
  expect(state.items.at(-1)).toEqual({ kind: 'failure', text: 'Engine exited' })
})

test('ready initializes session and session_state maps turn, context and cost status values', () => {
  let state = transcript(initialTranscript, {
    v: 1,
    type: 'ready',
    sessionId: 's1',
    model: 'model',
    repoRoot: '/repo',
    version: '1',
  })
  expect(state.connected).toBe(true)
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: {
      type: 'session_state',
      priced: true,
      sessionState: {
        sessionId: 's1',
        startTime: 0,
        turns: 3,
        usage: { input_tokens: 10, output_tokens: 5 },
        costUsd: 0.04,
        contextUtilization: 0.34,
        compactCount: 1,
        model: 'model',
      },
    },
  })
  expect(state.status).toEqual({ turn: 3, context: 0.34, cost: 0.04, priced: true })
  const restarted = transcript(state, {
    v: 1,
    type: 'ready',
    sessionId: 's2',
    model: 'model',
    repoRoot: '/other',
    version: '1',
  })
  expect(restarted.items).toEqual([])
  expect(restarted.status.turn).toBe(0)
})

test('learning, compaction and task notices remain distinct transcript items', () => {
  let state = transcript(initialTranscript, {
    v: 1,
    type: 'event',
    event: {
      type: 'rule_recall',
      trigger: 'session_start',
      rules: [{ id: 'r1', confidence: 0.8 }],
    },
  })
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: { type: 'compact', preTokens: 100, postTokens: 50, durationMs: 1 },
  })
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: { type: 'task_notice', text: 'Task completed' },
  })
  expect(state.items.map((item) => item.kind)).toEqual(['learning', 'notice', 'notice'])
})

test('permission_mode updates the pill state without resolving a pending request; ready resets Ask', () => {
  const request = {
    v: 1,
    type: 'permission_request',
    requestId: 'pending',
    toolName: 'Edit',
    input: {},
  } as const
  let state = transcript(initialTranscript, request)
  for (const mode of ['accept-edits', 'bypass', 'ask'] as const) {
    state = transcript(state, { v: 1, type: 'permission_mode', mode })
    expect(state.permissionMode).toBe(mode)
    expect(state.permission).toEqual(request)
  }
  state = transcript(state, { v: 1, type: 'permission_mode', mode: 'bypass' })
  state = transcript(state, {
    v: 1,
    type: 'ready',
    sessionId: 'new',
    model: 'model',
    repoRoot: '/repo',
    version: '1',
  })
  expect(state.permissionMode).toBe('ask')
})

test('Edit summary counts the actual line diff and is retained on its tool card', () => {
  expect(editLineCounts('keep\nold1\nold2\ntail\n', 'keep\nnew\ntail\n')).toEqual({
    added: 1,
    removed: 2,
  })
  expect(editLineCounts('same\n', 'same\n')).toEqual({ added: 0, removed: 0 })
  expect(editLineCounts('', 'new\n')).toEqual({ added: 1, removed: 0 })
  expect(editLineCounts('old\n', '')).toEqual({ added: 0, removed: 1 })
  expect(editLineCounts('a\nb', 'a\nc')).toEqual({ added: 1, removed: 1 })
  let state = transcript(initialTranscript, {
    v: 1,
    type: 'event',
    event: { type: 'tool_use', id: 'edit', name: 'Edit', input: { path: 'file' } },
  })
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: { type: 'tool_done', id: 'edit', name: 'Edit', status: 'done', summary: '+1 −2 lines' },
  })
  expect(state.items.at(-1)).toMatchObject({ status: 'done', summary: '+1 −2 lines' })
})
