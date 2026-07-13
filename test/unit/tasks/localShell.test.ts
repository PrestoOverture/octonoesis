import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { flushJournal } from '../../../src/memory/journal'
import type { QueryLoopContext } from '../../../src/query/types'
import { cleanupTasks, drainTaskNotifications } from '../../../src/tasks/framework'
import { startLocalShellTask } from '../../../src/tasks/localShell'
import { bashTool } from '../../../src/tools/Bash'

const roots: string[] = []
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let memoryDir = ''

async function waitForText(filePath: string, text: string): Promise<string> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const content = await fs.readFile(filePath, 'utf8').catch(() => '')
    if (content.includes(text)) return content
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(text)} in ${filePath}`)
}

async function waitForStatus(task: { status: string }, status: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (task.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for task status ${status}; received ${task.status}`)
}

beforeEach(async () => {
  memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-local-shell-memory-'))
  roots.push(memoryDir)
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
})

afterEach(async () => {
  await flushJournal()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  if (originalMemoryDir === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  else process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
})

describe('local background shell tasks', () => {
  it('returns while running, streams output to disk, and completes with a notification', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-local-shell-'))
    roots.push(root)
    const ctx: QueryLoopContext = { repoRoot: root, tasks: new Map() }

    const record = await startLocalShellTask({
      ctx,
      command: "printf 'alpha\\n'; sleep 0.2; printf 'omega\\n'",
    })

    expect(record.task.status).toBe('running')
    expect(ctx.tasks?.get(record.task.id)).toBe(record.task)
    expect(await waitForText(record.task.logPath ?? '', 'alpha')).toContain('alpha')

    await record.result
    expect(record.task.status).toBe('completed')
    expect(record.task.exitCode).toBe(0)
    expect(await fs.readFile(record.task.logPath ?? '', 'utf8')).toBe('alpha\nomega\n')
    const notifications = await drainTaskNotifications(ctx)
    expect(notifications.length).toBe(1)
    expect(notifications[0]).toContain(`<task_id>${record.task.id}</task_id>`)
    expect(notifications[0]).toContain('<status>completed</status>')
    expect(notifications[0]).toContain('<exit_code>0</exit_code>')
    await flushJournal()
    const journal = await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8')
    const statuses = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; task_id?: string; status?: string })
      .filter((event) => event.kind === 'task' && event.task_id === record.task.id)
      .map((event) => event.status)
    expect(statuses).toEqual(['running', 'completed'])
    const deliveredLogPath = record.task.logPath ?? ''
    await cleanupTasks(ctx)
    await expect(fs.access(deliveredLogPath)).rejects.toThrow()
  })

  it('starts through Bash without blocking and ignores query cancellation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-background-bash-'))
    roots.push(root)
    const controller = new AbortController()
    const ctx: QueryLoopContext = {
      repoRoot: root,
      abortSignal: controller.signal,
      tasks: new Map(),
    }

    const result = await bashTool.call(
      { command: "sleep 0.2; printf 'survived-abort\\n'", run_in_background: true },
      ctx,
    )
    controller.abort()

    expect(result.ok).toBe(true)
    const value = result.ok ? JSON.parse(result.value) : undefined
    expect(value?.status).toBe('running')
    expect(/^shell-[0-9a-f]{8}$/.test(value?.task_id ?? '')).toBe(true)
    const task = ctx.tasks?.get(value?.task_id)
    if (!task) throw new Error('Background Bash did not register its task')
    await waitForText(task.logPath ?? '', 'survived-abort')
    await waitForStatus(task, 'completed')
    expect(task.status).toBe('completed')
    await drainTaskNotifications(ctx)
  })

  it('records non-zero exits as failed with combined output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-failed-shell-'))
    roots.push(root)
    const ctx: QueryLoopContext = { repoRoot: root, tasks: new Map() }

    const record = await startLocalShellTask({
      ctx,
      command: "printf 'out\\n'; printf 'err\\n' >&2; exit 7",
    })
    await record.result

    expect(record.task.status).toBe('failed')
    expect(record.task.exitCode).toBe(7)
    const output = await fs.readFile(record.task.logPath ?? '', 'utf8')
    expect(output).toContain('out\n')
    expect(output).toContain('err\n')
    expect((await drainTaskNotifications(ctx))[0]).toContain('<status>failed</status>')
  })

  it('kills running work, journals killed, deletes logs, and cleans up idempotently', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-cleanup-shell-'))
    roots.push(root)
    const ctx: QueryLoopContext = { repoRoot: root, tasks: new Map() }
    const record = await startLocalShellTask({ ctx, command: 'sleep 30' })
    const logPath = record.task.logPath ?? ''

    await cleanupTasks(ctx)
    await cleanupTasks(ctx)
    await flushJournal()

    expect(record.task.status).toBe('killed')
    expect(ctx.tasks?.size).toBe(0)
    await expect(fs.access(logPath)).rejects.toThrow()
    const journal = await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8')
    const statuses = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; task_id?: string; status?: string })
      .filter((event) => event.kind === 'task' && event.task_id === record.task.id)
      .map((event) => event.status)
    expect(statuses).toEqual(['running', 'killed'])
  })

  it('rejects a fifth concurrently running shell task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-shell-cap-'))
    roots.push(root)
    const ctx: QueryLoopContext = { repoRoot: root, tasks: new Map() }
    for (let index = 0; index < 4; index++) {
      await startLocalShellTask({ ctx, command: 'sleep 30' })
    }

    await expect(startLocalShellTask({ ctx, command: 'true' })).rejects.toThrow(
      'Background shell task limit reached (4)',
    )
    await cleanupTasks(ctx)
  })
})
