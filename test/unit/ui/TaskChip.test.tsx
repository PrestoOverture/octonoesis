import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import type { QueryLoopContext, TaskState } from '../../../src/query/types'
import { App } from '../../../src/ui/App'
import { TaskChip } from '../../../src/ui/TaskChip'

function context(tasks: TaskState[] = []): QueryLoopContext {
  return {
    repoRoot: '/repo',
    tasks: new Map(tasks.map((task) => [task.id, task])),
  }
}

describe('TaskChip', () => {
  it('renders nothing when there are no tasks', () => {
    const { lastFrame, unmount } = render(<TaskChip ctx={context()} pollIntervalMs={10} />)
    expect(lastFrame()).toBe('')
    unmount()
  })

  it('shows a running task with its id, type, status, and elapsed time', () => {
    const now = Date.now()
    const task: TaskState = {
      id: 'shell-ab12cd34',
      type: 'shell',
      status: 'running',
      command: 'bun test',
      startTime: now,
    }
    const { lastFrame, unmount } = render(<TaskChip ctx={context([task])} pollIntervalMs={10} />)
    const frame = lastFrame()
    expect(frame).toContain('⏺ shell-ab12cd34')
    expect(frame).toContain('shell')
    expect(frame).toContain('running')
    expect(frame).toContain('0s')
    unmount()
  })

  it('polls the task map and reflects terminal status until delivery', async () => {
    const now = Date.now()
    const task: TaskState = {
      id: 'agent-cd34ef56',
      type: 'agent',
      status: 'running',
      startTime: now,
    }
    const ctx = context([task])
    const { lastFrame, unmount } = render(<TaskChip ctx={ctx} pollIntervalMs={10} />)

    task.status = 'completed'
    task.endTime = now + 2_000
    // Bounded poll instead of a fixed sleep: under heavy load (e.g. the full
    // suite running as a background task of a live session) a single 30ms
    // window can miss the poll tick + Ink re-render — observed at the Batch 3
    // Tier C gate. The loop only exits early on success; the assertions below
    // still fail hard if 'completed' never renders within the deadline.
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !(lastFrame() ?? '').includes('completed')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(lastFrame()).toContain('agent-cd34ef56')
    expect(lastFrame()).toContain('completed')
    expect(lastFrame()).toContain('2s')
    unmount()
  })

  it('is wired into App through the shared tool context', () => {
    const task: TaskState = {
      id: 'shell-app12345',
      type: 'shell',
      status: 'running',
      startTime: Date.now(),
    }
    const { lastFrame, unmount } = render(<App ctx={context([task])} />)
    expect(lastFrame()).toContain('shell-app12345')
    expect(lastFrame()).toContain('running')
    unmount()
  })
})
