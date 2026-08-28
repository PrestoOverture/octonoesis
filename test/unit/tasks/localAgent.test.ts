import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { flushJournal } from '../../../src/memory/journal'
import type { ForkHandle, ForkOptions, ForkResult } from '../../../src/providers/fork'
import type { QueryLoopContext } from '../../../src/query/types'
import { drainTaskNotifications } from '../../../src/tasks/framework'
import {
  MAX_BACKGROUND_AGENTS,
  clearLocalAgentsForTests,
  getLocalAgent,
  sendLocalAgentMessage,
  startLocalAgent,
} from '../../../src/tasks/localAgent'
import { SendMessageTool } from '../../../src/tools/SendMessageTool'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const completed: ForkResult = {
  text: 'done',
  usage: { input_tokens: 1, output_tokens: 2 },
  turns: 1,
  exitReason: 'completed',
}

function options(
  ctx: QueryLoopContext,
  result: Promise<ForkResult>,
  sendMessage: ForkHandle['sendMessage'] = () => ({ ok: true }),
) {
  return {
    ctx,
    forkOptions: {
      forkPurpose: 'agent',
      systemPrompt: 'stable',
      messages: [{ role: 'user', content: 'research' }],
      tools: [],
    } satisfies ForkOptions,
    createWorktree: async (_root: string, agentId: string) => ({
      repoRoot: '/repo',
      path: `/tmp/${agentId}`,
    }),
    startFork: () => ({ pid: 123, result, sendMessage, kill: async () => {} }),
  }
}

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let memoryDir = ''

beforeEach(async () => {
  memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-local-agent-test-'))
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
})

afterEach(async () => {
  clearLocalAgentsForTests()
  await flushJournal()
  await fs.rm(memoryDir, { recursive: true, force: true })
  if (originalMemoryDir === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  else process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
})

describe('local background agent registry', () => {
  it('keeps SendMessage read-only so delivery itself never prompts', () => {
    expect(new SendMessageTool().isReadOnly()).toBe(true)
  })

  it('refuses unknown, completed, and queue-full message targets', async () => {
    expect(sendLocalAgentMessage('missing', 'hello')).toEqual({
      ok: false,
      error: 'Unknown background agent: missing',
    })

    const ctx: QueryLoopContext = { repoRoot: memoryDir }
    const done = deferred<ForkResult>()
    const record = await startLocalAgent(options(ctx, done.promise))
    done.resolve(completed)
    await record.result
    expect(sendLocalAgentMessage(record.agentId, 'late').ok).toBe(false)

    const waiting = deferred<ForkResult>()
    const full = await startLocalAgent(
      options(ctx, waiting.promise, () => ({ ok: false, error: 'Agent message queue is full.' })),
    )
    expect(sendLocalAgentMessage(full.agentId, 'overflow')).toEqual({
      ok: false,
      error: 'Agent message queue is full.',
    })
  })

  it('enforces the four-running-agent cap', async () => {
    const ctx: QueryLoopContext = { repoRoot: memoryDir }
    const waiting = deferred<ForkResult>()
    for (let index = 0; index < MAX_BACKGROUND_AGENTS; index++) {
      await startLocalAgent(options(ctx, waiting.promise))
    }
    await expect(startLocalAgent(options(ctx, waiting.promise))).rejects.toThrow(
      'Background agent limit reached (4)',
    )
  })

  it('persists completion, notifies once, and evicts the delivered agent', async () => {
    const ctx: QueryLoopContext = { repoRoot: memoryDir, tasks: new Map() }
    const done = deferred<ForkResult>()
    let removed = 0
    const record = await startLocalAgent({
      ...options(ctx, done.promise),
      description: 'Inspect the repo',
      removeWorktree: async () => {
        removed++
      },
    })

    done.resolve(completed)
    await record.result

    expect(record.task.status).toBe('completed')
    expect(await fs.readFile(record.task.logPath ?? '', 'utf8')).toBe('done')
    const notifications = await drainTaskNotifications(ctx)
    expect(notifications.length).toBe(1)
    expect(notifications[0]).toContain('<task_type>agent</task_type>')
    expect(notifications[0]).toContain('<summary>Task "Inspect the repo" completed</summary>')
    expect(getLocalAgent(record.agentId)).toBeUndefined()
    expect(sendLocalAgentMessage(record.agentId, 'late')).toEqual({
      ok: false,
      error: `Unknown background agent: ${record.agentId}`,
    })
    expect(removed).toBe(1)
  })

  it('removes the worktree if task-log setup fails before the child starts', async () => {
    // taskLogPath resolves its directory via getMemoryDir() (OCTONOESIS_MEMORY_DIR), not
    // ctx.repoRoot, so the failure is injected by pointing the memory dir at a file instead
    // of a directory, forcing fs.mkdir to fail.
    const invalidMemoryDir = path.join(memoryDir, 'not-a-directory')
    await fs.writeFile(invalidMemoryDir, 'file')
    process.env.OCTONOESIS_MEMORY_DIR = invalidMemoryDir
    const ctx: QueryLoopContext = { repoRoot: memoryDir, tasks: new Map() }
    let removed = 0

    await expect(
      startLocalAgent({
        ...options(ctx, Promise.resolve(completed)),
        removeWorktree: async () => {
          removed++
        },
      }),
    ).rejects.toThrow()
    expect(removed).toBe(1)
  })
})
