import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { QueryLoopContext, TaskState } from '../../../src/query/types'
import {
  drainTaskNotifications,
  enqueueTaskNotification,
  taskLogPath,
} from '../../../src/tasks/framework'

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const roots: string[] = []

// taskLogPath resolves its directory via getMemoryDir(), so each test points
// OCTONOESIS_MEMORY_DIR at a subdirectory of its own temp root before calling it.
async function makeRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  process.env.OCTONOESIS_MEMORY_DIR = path.join(root, '.octonoesis')
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  if (originalMemoryDir === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  } else {
    process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  }
})

describe('background task framework', () => {
  it('creates the task-log directory lazily and returns the session-local log path', async () => {
    const root = await makeRoot('octonoesis-task-framework-')
    const tasksDir = path.join(root, '.octonoesis', 'tasks')
    await expect(fs.access(tasksDir)).rejects.toThrow()

    const logPath = await taskLogPath('shell-ab12cd34')

    expect(logPath).toBe(path.join(tasksDir, 'shell-ab12cd34.log'))
    expect((await fs.stat(tasksDir)).isDirectory()).toBe(true)
  })

  it('places the log under OCTONOESIS_MEMORY_DIR, not a hardcoded repoRoot-derived path', async () => {
    const root = await makeRoot('octonoesis-task-memdir-')
    const memoryDir = path.join(root, '.octonoesis')

    const logPath = await taskLogPath('shell-memdir01')

    expect(logPath).toBe(path.join(memoryDir, 'tasks', 'shell-memdir01.log'))
    expect(logPath.startsWith(memoryDir + path.sep)).toBe(true)

    // Changing OCTONOESIS_MEMORY_DIR must move where the log is written.
    const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-task-memdir-other-'))
    roots.push(otherRoot)
    const otherMemoryDir = path.join(otherRoot, '.octonoesis')
    process.env.OCTONOESIS_MEMORY_DIR = otherMemoryDir

    const otherLogPath = await taskLogPath('shell-memdir02')

    expect(otherLogPath).toBe(path.join(otherMemoryDir, 'tasks', 'shell-memdir02.log'))
    expect(otherLogPath.startsWith(memoryDir + path.sep)).toBe(false)
  })

  it('delivers one deterministic notification with a capped tail and evicts the task', async () => {
    const root = await makeRoot('octonoesis-task-notification-')
    const logPath = await taskLogPath('shell-ab12cd34')
    await fs.writeFile(logPath, `discard-me-${'x'.repeat(2_100)}`)
    const task: TaskState = {
      id: 'shell-ab12cd34',
      type: 'shell',
      status: 'completed',
      command: 'bun test',
      startTime: 1,
      endTime: 2,
      exitCode: 0,
      logPath,
    }
    const ctx: QueryLoopContext = { repoRoot: root, tasks: new Map([[task.id, task]]) }

    enqueueTaskNotification(ctx, task)
    enqueueTaskNotification(ctx, task)
    const notifications = await drainTaskNotifications(ctx)

    expect(notifications.length).toBe(1)
    expect(
      notifications[0]?.startsWith(
        '<task-notification>\n<task_id>shell-ab12cd34</task_id>\n<task_type>shell</task_type>\n<status>completed</status>\n<exit_code>0</exit_code>\n<output_file>.octonoesis/tasks/shell-ab12cd34.log</output_file>\n<summary>Task "bun test" completed (exit code 0)</summary>\n</task-notification>\nLast output:\n',
      ),
    ).toBe(true)
    expect(notifications[0]?.split('Last output:\n')[1]?.length).toBe(2_000)
    expect(task.notified).toBe(true)
    expect(ctx.tasks?.has(task.id)).toBe(false)
    expect(await drainTaskNotifications(ctx)).toEqual([])
  })

  it('reads only a bounded tail from a log file larger than 1 MB, matching the old whole-file-read answer', async () => {
    const root = await makeRoot('octonoesis-task-tail-bounded-')
    const logPath = await taskLogPath('shell-bounded01')
    // > 1 MB of ASCII content with a distinctive, non-repeating tail so a truncation-boundary
    // bug would be visible even if it merely shifted by a few characters.
    const filler = 'x'.repeat(1_100_000)
    const distinctiveTail = Array.from({ length: 2_500 }, (_, i) => String(i % 10)).join('')
    const content = filler + distinctiveTail
    await fs.writeFile(logPath, content)
    // TASK_OUTPUT_TAIL_CHARS is not exported; 2_000 mirrors the module constant, matching the
    // existing "delivers one deterministic notification" test's convention above.
    const oldImplementationAnswer = content.slice(-2_000)

    const task: TaskState = {
      id: 'shell-bounded01',
      type: 'shell',
      status: 'completed',
      command: 'produce a large log',
      startTime: 1,
      endTime: 2,
      exitCode: 0,
      logPath,
    }
    const ctx: QueryLoopContext = { repoRoot: root, tasks: new Map([[task.id, task]]) }

    enqueueTaskNotification(ctx, task)
    const notifications = await drainTaskNotifications(ctx)

    expect(notifications.length).toBe(1)
    const tail = notifications[0]?.split('Last output:\n')[1]
    expect(tail?.length).toBe(2_000)
    expect(tail).toBe(oldImplementationAnswer)
  })

  it('returns an empty output tail for a missing log file', async () => {
    const root = await makeRoot('octonoesis-task-tail-missing-')
    const missingLogPath = path.join(root, '.octonoesis', 'tasks', 'shell-missing01.log')
    const task: TaskState = {
      id: 'shell-missing01',
      type: 'shell',
      status: 'failed',
      command: 'never produced a log',
      startTime: 1,
      endTime: 2,
      exitCode: 1,
      logPath: missingLogPath,
    }
    const ctx: QueryLoopContext = { repoRoot: root, tasks: new Map([[task.id, task]]) }

    enqueueTaskNotification(ctx, task)
    const notifications = await drainTaskNotifications(ctx)

    expect(notifications.length).toBe(1)
    expect(notifications[0]?.split('Last output:\n')[1]).toBe('')
    expect(notifications[0]?.endsWith('Last output:\n')).toBe(true)
  })
})
