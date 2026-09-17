import fs from 'node:fs/promises'
import path from 'node:path'
import { appendJournal } from '../memory/journal'
import type { QueryLoopContext, TaskState } from '../query/types'
import { getMemoryDir } from '../utils/path'

const notificationQueues = new WeakMap<QueryLoopContext, TaskState[]>()
const sessionTaskLogs = new WeakMap<QueryLoopContext, Set<string>>()
const TERMINAL_STATUSES = new Set<TaskState['status']>(['completed', 'failed', 'killed'])
const TASK_OUTPUT_TAIL_CHARS = 2_000

/**
 * Ensures the tasks directory exists and returns the destination log file path for a task ID.
 *
 * @param taskId - Unique task identifier.
 * @returns Filesystem path to the task log file.
 */
export async function taskLogPath(taskId: string): Promise<string> {
  const directory = path.join(getMemoryDir(), 'tasks')
  await fs.mkdir(directory, { recursive: true })
  return path.join(directory, `${taskId}.log`)
}

/**
 * Calculates the total elapsed runtime in milliseconds for a task.
 *
 * @param task - Target TaskState object.
 * @returns Non-negative duration in milliseconds.
 */
function durationMs(task: TaskState): number {
  return Math.max(0, (task.endTime ?? Date.now()) - task.startTime)
}

/**
 * Registers a new task in the query context's task collection and records its initial transition.
 *
 * @param ctx - Query loop context.
 * @param task - TaskState object to register.
 */
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

/**
 * Appends a task state change entry to the journal and queues a notification if terminal.
 *
 * @param ctx - Query loop context.
 * @param task - TaskState object reflecting current status.
 */
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

/**
 * Enqueues a notification for a task once it reaches a terminal status ('completed', 'failed', 'killed').
 * Guarantees that each task is only enqueued once.
 *
 * @param ctx - Query loop context.
 * @param task - TaskState object to evaluate.
 */
export function enqueueTaskNotification(ctx: QueryLoopContext, task: TaskState): void {
  if (!TERMINAL_STATUSES.has(task.status) || task.notified) return
  task.notified = true
  const queue = notificationQueues.get(ctx) ?? []
  queue.push(task)
  notificationQueues.set(ctx, queue)
}

/**
 * Reads at most the last TASK_OUTPUT_TAIL_CHARS * 4 bytes of the log file (4 bytes is the
 * maximum UTF-8 width of one character, so this window always covers at least
 * TASK_OUTPUT_TAIL_CHARS real characters) instead of loading the whole file into memory, then
 * decodes and slices to the exact character tail. For ASCII logs (1 byte per character) this is
 * byte-identical to reading the whole file and slicing. If a multibyte character straddles the
 * read boundary, TextDecoder's default non-fatal mode replaces the truncated leading bytes with
 * U+FFFD rather than dropping them or throwing.
 */
async function readTaskTail(logPath: string | undefined): Promise<string> {
  if (!logPath) return ''
  const maxBytes = TASK_OUTPUT_TAIL_CHARS * 4
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(logPath, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return new TextDecoder('utf-8')
      .decode(buffer.subarray(0, bytesRead))
      .slice(-TASK_OUTPUT_TAIL_CHARS)
  } catch {
    return ''
  } finally {
    await handle?.close()
  }
}

/**
 * Computes a repository-relative path to a task's log file using POSIX forward slashes.
 *
 * @param ctx - Query loop context containing repoRoot.
 * @param task - TaskState object.
 * @returns Relative log file path.
 */
function relativeLogPath(ctx: QueryLoopContext, task: TaskState): string {
  if (!task.logPath) return `.octonoesis/tasks/${task.id}.log`
  return path.relative(ctx.repoRoot, task.logPath).split(path.sep).join('/')
}

/**
 * Escapes special XML characters (`&`, `<`, `>`, `"`, `'`) in a string for safe embedding in XML tags.
 *
 * @param value - Raw text string to escape.
 * @returns XML-safe escaped string.
 */
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

/**
 * Generates a human-readable one-line summary of a task's command/label, status, and exit code.
 *
 * @param task - TaskState object.
 * @returns Human-readable summary string.
 */
function taskSummary(task: TaskState): string {
  const label = escapeXmlText(task.command ?? task.id)
  if (task.type === 'shell' && task.exitCode !== undefined) {
    return `Task "${label}" ${task.status} (exit code ${task.exitCode})`
  }
  return `Task "${label}" ${task.status}`
}

/**
 * Formats an XML notification payload block representing a completed, failed, or killed task,
 * including task metadata and the tail of its log file.
 *
 * @param ctx - Query loop context.
 * @param task - Completed TaskState object.
 * @returns Formatted XML notification string.
 */
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

/**
 * Drains all queued terminal task notifications for a query context, removing evicted tasks from memory.
 *
 * @param ctx - Query loop context.
 * @returns Array of formatted XML notification strings for drained tasks.
 */
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

/**
 * Cleans up and terminates all running background tasks and agents for a query context,
 * deleting associated temporary task log files from disk.
 *
 * @param ctx - Active query loop context to clean up.
 */
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
