import { expect, test } from 'bun:test'
import type { HostMessage } from '../../../src/host/protocol'
import {
  type Workspace,
  initialWorkspace,
  liveSessionIds,
  sessionStatus,
  sessionTitle,
  workspace,
} from './workspace'

const session = (state: Workspace, key: string) => {
  const found = state.sessions[key]
  if (!found) throw new Error(`No session ${key}`)
  return found
}
const ready = (sessionId: string): HostMessage => ({
  v: 1,
  type: 'ready',
  sessionId,
  model: 'm',
  repoRoot: '/repo',
  version: '1',
})

test('each live session keeps its own transcript; messages route by key', () => {
  let state = workspace(initialWorkspace, { type: 'opened', key: 'a' })
  state = workspace(state, { type: 'session', key: 'a', action: ready('s-a') })
  state = workspace(state, { type: 'opened', key: 'b' })
  state = workspace(state, { type: 'session', key: 'b', action: ready('s-b') })
  state = workspace(state, {
    type: 'session',
    key: 'a',
    action: { type: 'user', text: 'fix the bug' },
  })
  expect(state.order).toEqual(['a', 'b'])
  expect(state.active).toBe('b')
  expect(sessionStatus(session(state, 'a'))).toBe('running')
  expect(sessionStatus(session(state, 'b'))).toBe('idle')
  expect(sessionTitle(session(state, 'a'))).toBe('fix the bug')
  expect(sessionTitle(session(state, 'b'))).toBe('New session')
  expect(workspace(state, { type: 'focus', key: 'a' }).active).toBe('a')
  expect(workspace(state, { type: 'focus', key: 'missing' })).toBe(state)
})

test('messages before the open response create the session; closed keys stay closed', () => {
  let state = workspace(initialWorkspace, { type: 'session', key: 'early', action: ready('s1') })
  expect(state.active).toBe('early')
  state = workspace(state, { type: 'opened', key: 'early' })
  expect(state.order).toEqual(['early'])
  state = workspace(state, { type: 'opened', key: 'second' })
  state = workspace(state, { type: 'focus', key: 'early' })
  state = workspace(state, { type: 'close', key: 'early' })
  expect(state.order).toEqual(['second'])
  expect(state.active).toBe('second')
  const late = workspace(state, {
    type: 'session',
    key: 'early',
    action: { type: 'host_exit', message: 'Engine exited (0).' },
  })
  expect(late).toBe(state)
  expect(workspace(state, { type: 'opened', key: 'early' }).order).toEqual(['second'])
  expect(
    workspace(workspace(state, { type: 'close', key: 'second' }), { type: 'focus', key: 'x' })
      .active,
  ).toBeUndefined()
})

test('status covers permission, starting and ended sessions', () => {
  let state = workspace(initialWorkspace, { type: 'opened', key: 'a' })
  expect(sessionStatus(session(state, 'a'))).toBe('starting')
  state = workspace(state, { type: 'session', key: 'a', action: ready('s') })
  state = workspace(state, {
    type: 'session',
    key: 'a',
    action: { v: 1, type: 'permission_request', requestId: 'r', toolName: 'Bash', input: {} },
  })
  expect(sessionStatus(session(state, 'a'))).toBe('permission')
  state = workspace(state, {
    type: 'session',
    key: 'a',
    action: { type: 'host_exit', message: 'x' },
  })
  expect(sessionStatus(session(state, 'a'))).toBe('disconnected')
})

test('saved sessions already open, directly or as the one a session resumed, are live', () => {
  let state = workspace(initialWorkspace, { type: 'session', key: 'a', action: ready('new-id') })
  state = workspace(state, {
    type: 'session',
    key: 'a',
    action: {
      v: 1,
      type: 'history',
      resumedFrom: 'old-id',
      updatedAt: '2026-11-07T00:00:00.000Z',
      entries: [],
    },
  })
  state = workspace(state, {
    type: 'session',
    key: 'a',
    action: {
      v: 1,
      type: 'sessions',
      sessions: [
        {
          id: 'old-id',
          updatedAt: '2026-11-07T00:00:00.000Z',
          preview: 'earlier work',
          messageCount: 4,
        },
      ],
    },
  })
  expect([...liveSessionIds(state)].sort()).toEqual(['new-id', 'old-id'])
  expect(sessionTitle(session(state, 'a'))).toBe('earlier work')
})
