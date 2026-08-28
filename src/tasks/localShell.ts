// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess handles are runtime-provided.
declare const Bun: any

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { QueryLoopContext, TaskState } from '../query/types'
import type { ResolvedSandboxConfig } from '../sandbox/types'
import { wrapWithSandbox } from '../sandbox/wrapper'
import { activeSubprocesses } from '../tools/Bash'
import { shellChildEnv } from '../utils/childEnv'
import { recordTaskTransition, registerTask, taskLogPath } from './framework'

export const MAX_BACKGROUND_SHELL_TASKS = 4

export interface LocalShellTaskRecord {
  task: TaskState
  ctx: QueryLoopContext
  process: { pid: number; exited: Promise<number>; kill: (signal?: number | string) => void }
  result: Promise<void>
  killRequested: boolean
  kill: () => Promise<void>
}

export interface StartLocalShellTaskOptions {
  ctx: QueryLoopContext
  command: string
  sandbox?: ResolvedSandboxConfig
}

const shellTasks = new Map<string, LocalShellTaskRecord>()

async function pumpStream(
  stream: ReadableStream<Uint8Array>,
  append: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) await append(value)
    }
  } finally {
    reader.releaseLock()
  }
}

function signalProcessGroup(record: LocalShellTaskRecord, signal: NodeJS.Signals): void {
  try {
    process.kill(-record.process.pid, signal)
  } catch {
    try {
      record.process.kill(signal)
    } catch {}
  }
}

async function killProcess(record: LocalShellTaskRecord): Promise<void> {
  record.killRequested = true
  signalProcessGroup(record, 'SIGTERM')
  let exited = false
  await Promise.race([
    record.process.exited.then(() => {
      exited = true
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ])
  if (!exited) signalProcessGroup(record, 'SIGKILL')
  await record.result
}

export async function startLocalShellTask(
  options: StartLocalShellTaskOptions,
): Promise<LocalShellTaskRecord> {
  const runningCount = Array.from(shellTasks.values()).filter(
    (record) => record.task.status === 'running',
  ).length
  if (runningCount >= MAX_BACKGROUND_SHELL_TASKS) {
    throw new Error(`Background shell task limit reached (${MAX_BACKGROUND_SHELL_TASKS}).`)
  }

  const taskId = `shell-${crypto.randomUUID().slice(0, 8)}`
  const logPath = await taskLogPath(taskId)
  await fs.writeFile(logPath, '')
  const log = await fs.open(logPath, 'a')

  // biome-ignore lint/suspicious/noExplicitAny: Bun process handle
  let processHandle: any
  try {
    processHandle = Bun.spawn({
      cmd: options.sandbox
        ? wrapWithSandbox(options.command, options.sandbox)
        : ['bash', '-c', options.command],
      cwd: options.ctx.repoRoot,
      env: shellChildEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
  } catch (error) {
    await log.close()
    await fs.rm(logPath, { force: true })
    throw error
  }

  const task: TaskState = {
    id: taskId,
    type: 'shell',
    status: 'running',
    command: options.command,
    startTime: Date.now(),
    logPath,
  }
  const record = {
    task,
    ctx: options.ctx,
    process: processHandle,
    result: Promise.resolve(),
    killRequested: false,
    kill: async () => {},
  } satisfies LocalShellTaskRecord
  record.kill = () => killProcess(record)
  shellTasks.set(taskId, record)
  activeSubprocesses.add(processHandle)
  registerTask(options.ctx, task)

  let writeQueue = Promise.resolve()
  const append = (chunk: Uint8Array): Promise<void> => {
    writeQueue = writeQueue.then(async () => {
      await log.write(chunk)
    })
    return writeQueue
  }

  record.result = (async () => {
    let exitCode: number | undefined
    let failure: unknown
    try {
      const results = await Promise.all([
        pumpStream(processHandle.stdout, append),
        pumpStream(processHandle.stderr, append),
        processHandle.exited as Promise<number>,
      ])
      exitCode = results[2]
      await writeQueue
    } catch (error) {
      failure = error
    } finally {
      await log.close().catch(() => {})
      activeSubprocesses.delete(processHandle)
    }

    task.endTime = Date.now()
    task.exitCode = exitCode
    if (record.killRequested) {
      task.status = 'killed'
      task.error = 'Shell task killed at session end.'
    } else if (failure) {
      task.status = 'failed'
      task.error = failure instanceof Error ? failure.message : String(failure)
    } else if (exitCode === 0) {
      task.status = 'completed'
    } else {
      task.status = 'failed'
      task.error = `Shell exited with code ${exitCode ?? 'unknown'}.`
    }
    recordTaskTransition(options.ctx, task)
  })()

  return record
}

export async function cleanupLocalShellTasks(ctx: QueryLoopContext): Promise<void> {
  const records = Array.from(shellTasks.values()).filter((record) => record.ctx === ctx)
  for (const record of records) {
    if (record.task.status === 'running') await record.kill()
  }
}

export function evictLocalShellTask(taskId: string): void {
  shellTasks.delete(taskId)
}
