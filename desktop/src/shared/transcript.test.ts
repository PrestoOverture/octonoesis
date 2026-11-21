import { expect, test } from 'bun:test'
import { editLineCounts } from '../../../src/host/editSummary'
import {
  initialTranscript,
  slashMatches,
  taskNoticeLabel,
  toolArgument,
  transcript,
} from './transcript'

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
  expect(state.status).toEqual({
    turn: 3,
    context: 0.34,
    cost: 0.04,
    priced: true,
    inputTokens: 10,
    outputTokens: 5,
  })
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
    event: {
      type: 'task_notice',
      text: '<task-notification><task_id>b1</task_id><status>completed</status><summary>bun   test\npassed</summary></task-notification>',
    },
  })
  expect(state.items.map((item) => item.kind)).toEqual(['learning', 'notice', 'notice'])
  expect(state.items.at(-1)).toEqual({
    kind: 'notice',
    text: 'Task › b1 completed: bun test passed',
  })
  expect(taskNoticeLabel('<task-notification>broken')).toBe('Task › background task update')
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

test('learning notices use singular rule only for a count of one', () => {
  expect(
    transcript(initialTranscript, {
      v: 1,
      type: 'event',
      event: { type: 'rule_recall', trigger: 'session_start', rules: [] },
    }).items,
  ).toEqual([])
  expect(
    transcript(initialTranscript, {
      v: 1,
      type: 'event',
      event: { type: 'rules_learned', created: [], updated: 0 },
    }).items,
  ).toEqual([])
  for (const count of [1, 2]) {
    const noun = count === 1 ? 'rule' : 'rules'
    const learned = transcript(initialTranscript, {
      v: 1,
      type: 'event',
      event: {
        type: 'rules_learned',
        created: Array.from({ length: count }, (_, i) => ({
          id: String(i),
          status: 'candidate' as const,
        })),
        updated: 1,
      },
    })
    expect(learned.items.at(-1)).toEqual({
      kind: 'learning',
      text: `Learned ${count} ${noun} · updated 1`,
    })
    expect(
      transcript(initialTranscript, {
        v: 1,
        type: 'event',
        event: { type: 'rules_learned', created: [], updated: count },
      }).items.at(-1),
    ).toEqual({ kind: 'learning', text: `Strengthened ${count} ${noun}` })
    const recalled = transcript(initialTranscript, {
      v: 1,
      type: 'event',
      event: {
        type: 'rule_recall',
        trigger: 'session_start',
        rules: Array.from({ length: count }, (_, i) => ({ id: String(i), confidence: 0.5 })),
      },
    })
    expect(recalled.items.at(-1)).toEqual({
      kind: 'learning',
      text: `Recalled ${count} ${noun}: ${Array.from({ length: count }, (_, i) => String(i)).join(', ')}`,
    })
  }
})

test('compaction notice pluralizes the remaining token count', () => {
  for (const count of [1, 2]) {
    const state = transcript(initialTranscript, {
      v: 1,
      type: 'event',
      event: { type: 'compact', preTokens: 10, postTokens: count, durationMs: 1 },
    })
    expect(state.items.at(-1)).toEqual({
      kind: 'notice',
      text: `Context compacted: 10 → ${count} ${count === 1 ? 'token' : 'tokens'}`,
    })
  }
})

const ready = {
  v: 1,
  type: 'ready',
  sessionId: 'new',
  model: 'model',
  repoRoot: '/repo',
  version: '1',
} as const

test('tool cards show repo-relative arguments and keep every tool summary', () => {
  let state = transcript(initialTranscript, ready)
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: { type: 'tool_use', id: 'r', name: 'Read', input: { path: '/repo/src/a.ts' } },
  })
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: { type: 'tool_done', id: 'r', name: 'Read', status: 'done', summary: '12 lines' },
  })
  expect(state.items.at(-1)).toMatchObject({ argument: 'src/a.ts', summary: '12 lines' })
  expect(toolArgument('Bash', { command: 'cd /repo && bun test\nmore' }, '/repo')).toBe('bun test')
  expect(toolArgument('TodoWrite', { todos: [] }, '/repo')).toBe('')
})

test('history replays a resumed session, settles open tools and notes the resume', () => {
  let state = transcript(initialTranscript, ready)
  state = transcript(state, {
    v: 1,
    type: 'history',
    resumedFrom: 'old',
    updatedAt: '2026-11-07T00:00:00.000Z',
    entries: [
      { type: 'user', text: 'fix it' },
      { type: 'text_delta', text: 'On it.' },
      { type: 'tool_use', id: 't', name: 'Edit', input: { path: '/repo/a.ts' } },
      { type: 'tool_done', id: 't', name: 'Edit', status: 'done', summary: '+1 −1 lines' },
      { type: 'tool_use', id: 'dangling', name: 'Read', input: { path: 'b' } },
    ],
  })
  expect(state.resumedFrom).toBe('old')
  expect(state.items.slice(0, 4)).toEqual([
    { kind: 'user', text: 'fix it' },
    { kind: 'assistant', text: 'On it.' },
    {
      kind: 'tool',
      id: 't',
      name: 'Edit',
      argument: 'a.ts',
      status: 'done',
      summary: '+1 −1 lines',
    },
    {
      kind: 'tool',
      id: 'dangling',
      name: 'Read',
      argument: 'b',
      status: 'error',
      summary: 'cancelled',
    },
  ])
  expect(state.items.at(-1)).toMatchObject({ kind: 'notice' })
  expect(state.running).toBe(false)
})

test('sessions, skills, todos and tasks replace their lists; ready clears them', () => {
  let state = transcript(initialTranscript, ready)
  state = transcript(state, {
    v: 1,
    type: 'sessions',
    sessions: [{ id: 'a', updatedAt: 'x', preview: 'p', messageCount: 2 }],
  })
  state = transcript(state, {
    v: 1,
    type: 'skills',
    skills: [{ name: 'deploy', description: 'd' }],
  })
  state = transcript(state, {
    v: 1,
    type: 'todos',
    todos: [{ id: '1', content: 'Write tests', status: 'open' }],
  })
  state = transcript(state, {
    v: 1,
    type: 'tasks',
    tasks: [{ id: 'b1', type: 'shell', status: 'running', startTime: 1 }],
  })
  expect([
    state.sessions.length,
    state.skills.length,
    state.todos.length,
    state.tasks.length,
  ]).toEqual([1, 1, 1, 1])
  const fresh = transcript(state, ready)
  expect([fresh.sessions, fresh.skills, fresh.todos, fresh.tasks]).toEqual([[], [], [], []])
})

test('stream retry drops the partial reply and unstarted tools', () => {
  let state = transcript(initialTranscript, { type: 'user', text: 'go' })
  state = transcript(state, { v: 1, type: 'event', event: { type: 'text_delta', text: 'Half' } })
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: { type: 'tool_use', id: 'x', name: 'Read', input: { path: 'a' } },
  })
  state = transcript(state, {
    v: 1,
    type: 'event',
    event: { type: 'stream_retry', attempt: 1, reason: 'reset' },
  })
  expect(state.items).toEqual([
    { kind: 'user', text: 'go' },
    { kind: 'assistant', text: 'Half' },
    { kind: 'notice', text: 'Connection lost, retrying (1/2)' },
  ])
})

test('slash completion matches skill names only for a leading bare command', () => {
  const skills = [
    { name: 'deploy', description: '' },
    { name: 'debug', description: '' },
    { name: 'test', description: '' },
  ]
  expect(slashMatches('/de', skills)?.map((skill) => skill.name)).toEqual(['deploy', 'debug'])
  expect(slashMatches('/', skills)?.length).toBe(3)
  expect(slashMatches('/deploy now', skills)).toBeUndefined()
  expect(slashMatches('hello /de', skills)).toBeUndefined()
})

test('checkpoints, changes and rules replace; a rewind marks later changes reverted', () => {
  let state = transcript(initialTranscript, {
    v: 1,
    type: 'checkpoints',
    entries: [
      { seq: 1, ts: 't', tool: 'Edit', path: 'a', created: false },
      { seq: 2, ts: 't', tool: 'Write', path: 'b', created: true },
    ],
    commands: [],
  })
  state = transcript(state, { v: 1, type: 'changes', files: [] })
  state = transcript(state, { v: 1, type: 'learning', rules: [] })
  expect(state.changes).toEqual([])
  expect(state.rules).toEqual([])
  state = transcript(state, {
    v: 1,
    type: 'rewind_failed',
    seq: 2,
    message: 'b changed',
    conflict: true,
  })
  expect(state.rewindError?.conflict).toBe(true)
  expect(transcript(state, { type: 'rewind_dismissed' }).rewindError).toBeUndefined()
  state = transcript(state, { v: 1, type: 'rewound', seq: 2, restored: ['b'] })
  expect(state.reverted).toEqual([2])
  expect(state.rewindError).toBeUndefined()
  state = transcript(state, { v: 1, type: 'rewound', seq: 1, restored: ['a', 'b'] })
  expect(state.reverted).toEqual([2, 1])
  expect(state.items.map((item) => (item.kind === 'notice' ? item.text : ''))).toEqual([
    'Rewound 1 file to before change #2',
    'Rewound 2 files to before change #1',
  ])
})
