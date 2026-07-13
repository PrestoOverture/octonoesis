import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import {
  type ForkHandle,
  type ForkOptions,
  type ForkResult,
  startForkAgent,
} from '../providers/fork'
import type { Usage } from '../providers/types'
import type { QueryLoopContext, TaskState } from '../query/types'
import { type AgentWorktree, createAgentWorktree, removeAgentWorktree } from '../utils/worktree'
import { recordTaskTransition, registerTask, taskLogPath } from './framework'

export const MAX_BACKGROUND_AGENTS = 4

export interface LocalAgentRecord {
  agentId: string
  ctx: QueryLoopContext
  task: TaskState
  handle: ForkHandle
  worktree: AgentWorktree
  worktreeRemoved: boolean
  removeWorktree: typeof removeAgentWorktree
  result: Promise<ForkResult>
}

export interface StartLocalAgentOptions {
  ctx: QueryLoopContext
  forkOptions: ForkOptions
  onForkUsage?: (usage: Usage) => void
  createWorktree?: typeof createAgentWorktree
  removeWorktree?: typeof removeAgentWorktree
  startFork?: typeof startForkAgent
  description?: string
}

const agents = new Map<string, LocalAgentRecord>()
const liveSessions = new WeakSet<QueryLoopContext>()

export async function startLocalAgent(options: StartLocalAgentOptions): Promise<LocalAgentRecord> {
  const runningCount = Array.from(agents.values()).filter(
    (record) => record.task.status === 'running',
  ).length
  if (runningCount >= MAX_BACKGROUND_AGENTS) {
    throw new Error(`Background agent limit reached (${MAX_BACKGROUND_AGENTS}).`)
  }

  const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`
  const worktree = await (options.createWorktree ?? createAgentWorktree)(
    options.ctx.repoRoot,
    agentId,
  )
  const removeWorktree = options.removeWorktree ?? removeAgentWorktree
  let logPath: string
  try {
    logPath = await taskLogPath(options.ctx.repoRoot, agentId)
    await fs.writeFile(logPath, '')
  } catch (error) {
    await removeWorktree(worktree)
    throw error
  }
  let handle: ForkHandle
  try {
    handle = (options.startFork ?? startForkAgent)({
      ...options.forkOptions,
      repoRoot: worktree.path,
    })
  } catch (error) {
    await fs.rm(logPath, { force: true })
    await removeWorktree(worktree)
    throw error
  }

  const task: TaskState = {
    id: agentId,
    type: 'agent',
    status: 'running',
    startTime: Date.now(),
    command: options.description ?? 'background agent',
    logPath,
  }
  liveSessions.add(options.ctx)
  registerTask(options.ctx, task)

  const record = {} as LocalAgentRecord
  record.agentId = agentId
  record.ctx = options.ctx
  record.task = task
  record.handle = handle
  record.worktree = worktree
  record.worktreeRemoved = false
  record.removeWorktree = removeWorktree
  record.result = handle.result.then(async (result) => {
    if (task.status === 'killed') return result
    task.endTime = Date.now()
    task.output = result.text
    task.usage = { ...result.usage }
    if (result.exitReason === 'completed') {
      task.status = 'completed'
    } else {
      task.status = 'failed'
      task.error = result.error ?? `Agent exited: ${result.exitReason}`
    }
    await fs.writeFile(
      task.logPath ?? logPath,
      task.status === 'completed' ? result.text : (task.error ?? result.text),
    )
    if (liveSessions.has(options.ctx)) options.onForkUsage?.(result.usage)
    recordTaskTransition(options.ctx, task)
    return result
  })
  agents.set(agentId, record)
  return record
}

export function getLocalAgent(agentId: string): LocalAgentRecord | undefined {
  return agents.get(agentId)
}

export function sendLocalAgentMessage(
  agentId: string,
  message: string,
): { ok: true } | { ok: false; error: string } {
  const record = agents.get(agentId)
  if (!record) return { ok: false, error: `Unknown background agent: ${agentId}` }
  if (record.task.status !== 'running') {
    return { ok: false, error: `Agent ${agentId} is ${record.task.status}.` }
  }
  return record.handle.sendMessage(message)
}

export async function cleanupLocalAgents(ctx: QueryLoopContext): Promise<void> {
  liveSessions.delete(ctx)
  const records = Array.from(agents.values()).filter((record) => record.ctx === ctx)
  for (const record of records) {
    if (record.task.status === 'running') {
      record.task.status = 'killed'
      record.task.endTime = Date.now()
      record.task.error = 'Agent killed at session end.'
      await fs.writeFile(record.task.logPath ?? '', record.task.error)
      recordTaskTransition(ctx, record.task)
      await record.handle.kill()
    }
    if (!record.worktreeRemoved) {
      await record.removeWorktree(record.worktree)
      record.worktreeRemoved = true
    }
  }
}

export async function evictLocalAgent(agentId: string): Promise<void> {
  const record = agents.get(agentId)
  if (!record) return
  if (!record.worktreeRemoved) {
    await record.removeWorktree(record.worktree)
    record.worktreeRemoved = true
  }
  agents.delete(agentId)
}

export function clearLocalAgentsForTests(): void {
  agents.clear()
}
