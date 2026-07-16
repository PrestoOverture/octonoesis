import fs from 'node:fs/promises'
import path from 'node:path'
import { appendJournal } from '../memory/journal'
import type { QueryLoopContext, TaskState } from '../query/types'

const notificationQueues = new WeakMap<QueryLoopContext, TaskState[]>()
const sessionTaskLogs = new WeakMap<QueryLoopContext, Set<string>>()
const TERMINAL_STATUSES = new Set<TaskState['status']>(['completed', 'failed', 'killed'])
const TASK_OUTPUT_TAIL_CHARS = 2_000

export async function taskLogPath(repoRoot: string, taskId: string): Promise<string> {
  const directory = path.join(repoRoot, '.octonoesis', 'tasks')
  await fs.mkdir(directory, { recursive: true })
  return path.join(directory, `${taskId}.log`)
}

function durationMs(task: TaskState): number {
  return Math.max(0, (task.endTime ?? Date.now()) - task.startTime)
}

export function registerTask(ctx: QueryLoopContext, task: TaskState): void {
  ctx.tasks ??= new Map()
  ctx.tasks.set(task.id, task)
  if (task.logPath) {
    const logs = sessionTaskLogs.get(ctx) ?? new Set<string>()
    logs.add(task.logPath)
    sessionTaskLogs.set(ctx, logs)
  }
  recordTaskTransition(ctx, task)
}

export function recordTaskTransition(ctx: QueryLoopContext, task: TaskState): void {
  appendJournal({
    kind: 'task',
    task_id: task.id,
    type: task.type,
    status: task.status,
    duration_ms: durationMs(task),
  })
  enqueueTaskNotification(ctx, task)
}

export function enqueueTaskNotification(ctx: QueryLoopContext, task: TaskState): void {
  if (!TERMINAL_STATUSES.has(task.status) || task.notified) return
  task.notified = true
  const queue = notificationQueues.get(ctx) ?? []
  queue.push(task)
  notificationQueues.set(ctx, queue)
}

async function readTaskTail(logPath: string | undefined): Promise<string> {
  if (!logPath) return ''
  try {
    const output = await fs.readFile(logPath, 'utf8')
    return output.slice(-TASK_OUTPUT_TAIL_CHARS)
  } catch {
    return ''
  }
}

function relativeLogPath(ctx: QueryLoopContext, task: TaskState): string {
  if (!task.logPath) return `.octonoesis/tasks/${task.id}.log`
  return path.relative(ctx.repoRoot, task.logPath).split(path.sep).join('/')
}

function escapeXmlText(value: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character)
}

function taskSummary(task: TaskState): string {
  const label = escapeXmlText(task.command ?? task.id)
  if (task.type === 'shell' && task.exitCode !== undefined) {
    return `Task "${label}" ${task.status} (exit code ${task.exitCode})`
  }
  return `Task "${label}" ${task.status}`
}

async function formatTaskNotification(ctx: QueryLoopContext, task: TaskState): Promise<string> {
  const lines = [
    '<task-notification>',
    `<task_id>${task.id}</task_id>`,
    `<task_type>${task.type}</task_type>`,
    `<status>${task.status}</status>`,
  ]
  if (task.type === 'shell') lines.push(`<exit_code>${task.exitCode ?? ''}</exit_code>`)
  lines.push(
    `<output_file>${relativeLogPath(ctx, task)}</output_file>`,
    `<summary>${taskSummary(task)}</summary>`,
    '</task-notification>',
    'Last output:',
    await readTaskTail(task.logPath),
  )
  return lines.join('\n')
}

export async function drainTaskNotifications(ctx: QueryLoopContext): Promise<string[]> {
  const tasks = notificationQueues.get(ctx) ?? []
  notificationQueues.delete(ctx)
  const notifications: string[] = []
  for (const task of tasks) {
    notifications.push(await formatTaskNotification(ctx, task))
    ctx.tasks?.delete(task.id)
    if (task.type === 'shell') {
      const { evictLocalShellTask } = await import('./localShell')
      evictLocalShellTask(task.id)
    } else {
      const { evictLocalAgent } = await import('./localAgent')
      await evictLocalAgent(task.id)
    }
  }
  return notifications
}

export async function cleanupTasks(ctx: QueryLoopContext): Promise<void> {
  const tasks = Array.from(ctx.tasks?.values() ?? [])
  const { cleanupLocalShellTasks, evictLocalShellTask } = await import('./localShell')
  const { cleanupLocalAgents, evictLocalAgent } = await import('./localAgent')

  await cleanupLocalShellTasks(ctx)
  await cleanupLocalAgents(ctx)

  for (const task of tasks) {
    if (task.type === 'shell') evictLocalShellTask(task.id)
    else await evictLocalAgent(task.id)
  }
  const logs = sessionTaskLogs.get(ctx) ?? new Set<string>()
  await Promise.all(Array.from(logs, (logPath) => fs.rm(logPath, { force: true })))
  sessionTaskLogs.delete(ctx)
  notificationQueues.delete(ctx)
  ctx.tasks?.clear()
}
