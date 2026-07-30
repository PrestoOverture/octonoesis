import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent,
} from '../../src/providers/types'
import { type QueryResult, query } from '../../src/query/engine'
import type { QueryLoopContext } from '../../src/query/types'
import { cleanupTasks } from '../../src/tasks/framework'

const roots: string[] = []
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-background-engine-'))
  roots.push(root)
  return root
}

async function collectQuery(
  generator: AsyncGenerator<unknown, QueryResult, undefined>,
): Promise<QueryResult> {
  let step = await generator.next()
  while (!step.done) step = await generator.next()
  return step.value
}

async function waitForTaskStatus(
  ctx: QueryLoopContext,
  taskId: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (ctx.tasks?.get(taskId)?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${taskId} to reach ${status}`)
}

beforeEach(async () => {
  const memoryDir = await makeRoot()
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  clearAllowlist()
  unregisterPromptHandler()
  registerPromptHandler(async () => 'allow_once')
})

afterEach(async () => {
  unregisterPromptHandler()
  clearAllowlist()
  setProvider(null)
  if (originalMemoryDir === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  else process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  if (originalDisableMemory === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
  } else process.env.OCTONOESIS_DISABLE_MEMORY = originalDisableMemory
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('background task engine integration', () => {
  it('returns the Bash task immediately and sends its completion notification on the next turn', async () => {
    const repoRoot = await makeRoot()
    await fs.writeFile(path.join(repoRoot, 'canary.txt'), 'canary')
    const calls: CanonicalMessage[][] = []
    let turn = 0
    let advertisedBash: CanonicalTool | undefined
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(
        messages: CanonicalMessage[],
        tools: CanonicalTool[],
      ): AsyncIterable<StreamEvent> {
        calls.push(structuredClone(messages))
        advertisedBash = tools.find((tool) => tool.name === 'Bash')
        turn++
        if (turn === 1) {
          yield {
            type: 'tool_use',
            id: 'background-bash-1',
            name: 'Bash',
            input: {
              command: "sleep 0.15; printf 'engine-background-done\\n'",
              run_in_background: true,
            },
          }
        } else if (turn === 2) {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            const done = Array.from(ctx.tasks?.values() ?? []).some((t) => t.status === 'completed')
            if (done) break
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          yield {
            type: 'tool_use',
            id: 'read-while-running',
            name: 'Read',
            input: { path: 'canary.txt' },
          }
        } else {
          yield { type: 'text_delta', text: 'Observed background completion.' }
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)
    const ctx: QueryLoopContext = {
      repoRoot,
      sessionId: 'background-engine-session',
      tasks: new Map(),
    }

    const result = await collectQuery(query('Run the long check in the background', ctx))

    expect(result.exit_reason).toBe('completed')
    const bashProperties = advertisedBash?.inputSchema.properties
    expect(
      typeof bashProperties === 'object' &&
        bashProperties !== null &&
        'run_in_background' in bashProperties,
    ).toBe(true)
    const immediateResult = calls[1]?.find(
      (message) => message.role === 'tool' && message.tool_use_id === 'background-bash-1',
    )
    const immediateContent =
      immediateResult?.role === 'tool' && typeof immediateResult.content === 'string'
        ? JSON.parse(immediateResult.content)
        : undefined
    expect(immediateContent?.status).toBe('running')
    const notification = calls[2]?.find(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('<task-notification>'),
    )
    expect(JSON.stringify(notification)).toContain('<task_type>shell</task_type>')
    expect(JSON.stringify(notification)).toContain('<status>completed</status>')
    expect(JSON.stringify(notification)).toContain('<exit_code>0</exit_code>')
    expect(JSON.stringify(notification)).toContain('engine-background-done')
    await cleanupTasks(ctx)
  })

  it('keeps a task alive across query calls and injects it into query two’s first provider call', async () => {
    const repoRoot = await makeRoot()
    const ctx: QueryLoopContext = {
      repoRoot,
      sessionId: 'background-cross-query-session',
      tasks: new Map(),
    }
    let firstQueryTurn = 0
    setProvider({
      name: 'anthropic',
      async *createMessageStream(): AsyncIterable<StreamEvent> {
        firstQueryTurn++
        if (firstQueryTurn === 1) {
          yield {
            type: 'tool_use',
            id: 'cross-query-bash',
            name: 'Bash',
            input: {
              command: "sleep 0.3; printf 'cross-query-done\\n'",
              run_in_background: true,
            },
          }
        } else {
          yield { type: 'text_delta', text: 'Task launched.' }
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })

    const firstResult = await collectQuery(query('Launch it', ctx))
    expect(firstResult.exit_reason).toBe('completed')
    const task = Array.from(ctx.tasks?.values() ?? [])[0]
    if (!task) throw new Error('Query one did not leave a background task')
    expect(task.status).toBe('running')
    await waitForTaskStatus(ctx, task.id, 'completed')

    let firstMessages: CanonicalMessage[] | undefined
    setProvider({
      name: 'anthropic',
      async *createMessageStream(messages: CanonicalMessage[]): AsyncIterable<StreamEvent> {
        firstMessages ??= structuredClone(messages)
        yield { type: 'text_delta', text: 'Handled prior task.' }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })
    const secondResult = await collectQuery(query('What finished?', ctx))

    expect(secondResult.exit_reason).toBe('completed')
    const notification = firstMessages?.find(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes(`<task_id>${task.id}</task_id>`),
    )
    expect(JSON.stringify(notification)).toContain('<status>completed</status>')
    expect(JSON.stringify(notification)).toContain('cross-query-done')
    expect(ctx.tasks?.has(task.id)).toBe(false)
    await cleanupTasks(ctx)
  })

  it('leaves background work running when the query is aborted', async () => {
    const repoRoot = await makeRoot()
    const controller = new AbortController()
    const ctx: QueryLoopContext = {
      repoRoot,
      sessionId: 'background-abort-session',
      tasks: new Map(),
    }
    let turn = 0
    setProvider({
      name: 'anthropic',
      async *createMessageStream(): AsyncIterable<StreamEvent> {
        turn++
        if (turn === 1) {
          yield {
            type: 'tool_use',
            id: 'abort-survivor-bash',
            name: 'Bash',
            input: { command: 'sleep 30', run_in_background: true },
          }
        } else {
          setTimeout(() => controller.abort(), 10)
          await new Promise((resolve) => setTimeout(resolve, 50))
          yield { type: 'text_delta', text: 'must be cancelled' }
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })

    const result = await collectQuery(query('Start and keep it running', ctx, controller.signal))

    expect(result.exit_reason).toBe('user_cancel')
    const task = Array.from(ctx.tasks?.values() ?? [])[0]
    if (!task) throw new Error('Aborted query lost its background task')
    expect(task.status).toBe('running')
    expect(ctx.tasks?.has(task.id)).toBe(true)
    await cleanupTasks(ctx)
    expect(task.status).toBe('killed')
  })
})
