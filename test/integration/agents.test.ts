// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess handles are runtime-provided.
declare const Bun: any

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { flushJournal, setSessionId } from '../../src/memory/journal'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import {
  type ForkResult,
  type PreparedFork,
  buildForkCommand,
  serializeForkPayload,
} from '../../src/providers/fork'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent,
} from '../../src/providers/types'
import { type QueryResult, query, runQuery } from '../../src/query/engine'
import type { QueryLoopContext } from '../../src/query/types'
import { cleanupTasks, drainTaskNotifications } from '../../src/tasks/framework'
import {
  cleanupLocalAgents,
  clearLocalAgentsForTests,
  getLocalAgent,
} from '../../src/tasks/localAgent'
import { AgentTool } from '../../src/tools/AgentTool'
import { bashTool } from '../../src/tools/Bash'
import { editTool } from '../../src/tools/Edit'
import { globTool } from '../../src/tools/Glob'
import { grepTool } from '../../src/tools/Grep'
import { readTool } from '../../src/tools/Read'
import { SendMessageTool } from '../../src/tools/SendMessageTool'
import { todoWriteTool } from '../../src/tools/TodoWrite'
import { writeTool } from '../../src/tools/Write'
import { runTool } from '../../src/tools/execute'
import { clearRegistry, registerTool } from '../../src/tools/registry'

const execFileAsync = promisify(execFile)
const cliPath = path.resolve('src/cli.tsx')
const originalMain = Bun.main
const originalCwd = process.cwd()
const originalMock = process.env.OCTONOESIS_FORK_MOCK
const originalDepth = process.env.OCTONOESIS_FORK_DEPTH
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY
const roots: string[] = []
const backgroundContexts: QueryLoopContext[] = []
let memoryDir = ''

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', root, ...args])).stdout.trim()
}

async function makeRoot(gitRepo = false): Promise<string> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-agent-test-'))
  const root = await fs.realpath(raw)
  roots.push(root)
  if (gitRepo) {
    await execFileAsync('git', ['init', '-q', root])
    await git(root, 'config', 'user.email', 'test@example.com')
    await git(root, 'config', 'user.name', 'Test')
  }
  return root
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function runDirectChild(
  payload: string,
  mock: Record<string, unknown>,
): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn({
    cmd: buildForkCommand(process.execPath, cliPath),
    cwd: process.cwd(),
    env: {
      ...process.env,
      OCTONOESIS_FORK_DEPTH: '1',
      OCTONOESIS_FORK_MOCK: JSON.stringify(mock),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  child.stdin.write(payload)
  await child.stdin.end()
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

function registerAgentDependencies(): void {
  clearRegistry()
  for (const tool of [readTool, globTool, bashTool, writeTool, editTool, grepTool, todoWriteTool]) {
    registerTool(tool)
  }
}

function requiredAgent(agentId: string) {
  const record = getLocalAgent(agentId)
  if (!record) throw new Error(`Missing test agent: ${agentId}`)
  return record
}

async function collectQuery(
  generator: AsyncGenerator<unknown, QueryResult, undefined>,
): Promise<QueryResult> {
  let step = await generator.next()
  while (!step.done) step = await generator.next()
  return step.value
}

beforeEach(async () => {
  Bun.main = cliPath
  Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
  clearAllowlist()
  unregisterPromptHandler()
  registerAgentDependencies()
  clearLocalAgentsForTests()
  memoryDir = await makeRoot()
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  setSessionId(`agent-test-${Date.now()}`)
})

afterEach(async () => {
  unregisterPromptHandler()
  clearAllowlist()
  await Promise.allSettled(backgroundContexts.splice(0).map((ctx) => cleanupLocalAgents(ctx)))
  clearLocalAgentsForTests()
  clearRegistry()
  registerAgentDependencies()
  setProvider(null)
  await flushJournal()
  process.chdir(originalCwd)
  Bun.main = originalMain
  if (originalMock === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_MOCK')
  else process.env.OCTONOESIS_FORK_MOCK = originalMock
  if (originalDepth === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
  else process.env.OCTONOESIS_FORK_DEPTH = originalDepth
  if (originalMemoryDir === undefined) Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  else process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  if (originalDisableMemory === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
  } else process.env.OCTONOESIS_DISABLE_MEMORY = originalDisableMemory
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('multi-agent real child integration', () => {
  it('advertises Agent and SendMessage through the engine and returns a foreground result', async () => {
    const root = await makeRoot()
    await fs.writeFile(path.join(root, 'canary.txt'), 'engine-agent-canary')
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({
      validatePairing: true,
      scriptedEvents: [
        [
          { type: 'tool_use', id: 'read-engine', name: 'Read', input: { path: 'canary.txt' } },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        [
          { type: 'text_delta', text: 'Child found {{tool_result}}' },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      ],
    })
    let turn = 0
    let advertised: string[] = []
    let childResult = ''
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(
        messages: CanonicalMessage[],
        tools: CanonicalTool[],
      ): AsyncIterable<StreamEvent> {
        advertised = tools.map((tool) => tool.name)
        if (turn++ === 0) {
          yield {
            type: 'tool_use',
            id: 'agent-engine-1',
            name: 'Agent',
            input: { description: 'Inspect', prompt: 'Read canary.txt' },
          }
        } else {
          childResult = JSON.stringify(
            messages.find(
              (message) => message.role === 'tool' && message.tool_use_id === 'agent-engine-1',
            ),
          )
          yield { type: 'text_delta', text: 'Parent received result.' }
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)
    registerPromptHandler(async () => 'allow_once')

    const result = await collectQuery(
      query('Delegate a check', { repoRoot: root, sessionId: 'agent-engine-session' }),
    )

    expect(result.exit_reason).toBe('completed')
    expect(advertised).toContain('Agent')
    expect(advertised).toContain('SendMessage')
    expect(childResult).toContain('engine-agent-canary')
  })

  it('foreground Agent prompts, reads from resolved repoRoot, returns text, and journals', async () => {
    const root = await makeRoot()
    const subdir = path.join(root, 'nested')
    await fs.mkdir(subdir)
    await fs.writeFile(path.join(root, 'canary.txt'), 'foreground-canary')
    process.chdir(subdir)
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({
      scriptedEvents: [
        [
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'canary.txt' } },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        [
          { type: 'text_delta', text: 'Grounded: {{tool_result}}' },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      ],
    })
    const systemPrompt = 'byte-identical-agent-system'
    const agentTool = new AgentTool({ systemPrompt, model: 'parent-model' })
    registerTool(agentTool)
    let prompted = 0
    registerPromptHandler(async () => {
      prompted++
      return 'allow_once'
    })
    const ctx = {
      repoRoot: root,
      messages: [{ role: 'user' as const, content: 'Parent context snapshot' }],
    }

    const result = await runTool(
      'Agent',
      { description: 'Inspect canary', prompt: 'Read canary.txt' },
      ctx,
    )
    await flushJournal()

    expect(result.ok).toBe(true)
    expect(result.ok && String(result.value)).toContain('foreground-canary')
    expect(prompted).toBe(1)
    const journal = await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8')
    expect(journal).toContain('"tool":"Agent"')

    const prepared: PreparedFork = {
      repoRoot: root,
      systemPrompt,
      messages: [{ role: 'user', content: 'test child defense' }],
      tools: [{ name: 'Bash', description: 'bash', inputSchema: { type: 'object' } }],
      childEnv: { OCTONOESIS_FORK_DEPTH: '1' },
      budget: { maxTurns: 2 },
      purpose: 'agent',
      model: 'mock',
    }
    const smuggled = await runDirectChild(serializeForkPayload(prepared), {
      scriptedEvents: [
        [
          { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'touch escaped' } },
          { type: 'message_end', usage: { input_tokens: 0, output_tokens: 0 } },
        ],
        [
          { type: 'text_delta', text: 'refused={{tool_is_error}}' },
          { type: 'message_end', usage: { input_tokens: 0, output_tokens: 0 } },
        ],
      ],
    })
    expect(smuggled.code).toBe(0)
    const smuggledResult = JSON.parse(smuggled.stdout) as ForkResult
    expect(smuggledResult.text).toBe('refused=true')
    expect(smuggledResult.systemPromptSha256).toBe(
      createHash('sha256').update(systemPrompt).digest('hex'),
    )
    await expect(fs.access(path.join(root, 'escaped'))).rejects.toThrow()

    const invalid = JSON.parse(serializeForkPayload(prepared)) as Record<string, unknown>
    Reflect.deleteProperty(invalid, 'repoRoot')
    const invalidResult = await runDirectChild(JSON.stringify(invalid), { text: 'must not run' })
    expect(invalidResult.code).not.toBe(0)
    expect(invalidResult.stderr).toContain('Invalid fork payload')
  })

  it('background agents use HEAD worktrees, journal completion, and kill cleanly', async () => {
    const root = await makeRoot(true)
    await fs.writeFile(path.join(root, 'canary.txt'), 'committed-head-canary')
    await git(root, 'add', 'canary.txt')
    await git(root, 'commit', '-qm', 'canary')
    await fs.writeFile(path.join(root, 'dirty-only.txt'), 'must not cross into worktree')
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({
      delayMs: 250,
      scriptedEvents: [
        [
          { type: 'tool_use', id: 'read-bg', name: 'Read', input: { path: 'canary.txt' } },
          { type: 'message_end', usage: { input_tokens: 2, output_tokens: 1 } },
        ],
        [
          { type: 'text_delta', text: 'Background: {{tool_result}}' },
          { type: 'message_end', usage: { input_tokens: 3, output_tokens: 2 } },
        ],
      ],
    })
    let usageCalls = 0
    const tool = new AgentTool({
      systemPrompt: 'background-stable',
      model: 'parent-model',
      onForkUsage: () => usageCalls++,
    })
    const ctx = { repoRoot: root, messages: [], tasks: new Map() }
    backgroundContexts.push(ctx)
    const started = await tool.call(
      { description: 'Background read', prompt: 'Read canary.txt', background: true },
      ctx,
    )
    expect(started.ok).toBe(true)
    const value = started.ok ? started.value : undefined
    expect(typeof value).toBe('object')
    const agentId = typeof value === 'object' ? value.agentId : ''
    const record = requiredAgent(agentId)
    expect(record.task.status).toBe('running')
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain(record.worktree.path)
    expect(await fs.readFile(path.join(record.worktree.path, 'canary.txt'), 'utf8')).toBe(
      'committed-head-canary',
    )
    await expect(fs.access(path.join(record.worktree.path, 'dirty-only.txt'))).rejects.toThrow()

    const result = await record.result
    expect(result.text).toContain('committed-head-canary')
    expect(record.task.status).toBe('completed')
    expect(record.task.usage).toEqual({ input_tokens: 5, output_tokens: 3 })
    expect(usageCalls).toBe(1)
    expect(await fs.readFile(record.task.logPath ?? '', 'utf8')).toContain('committed-head-canary')
    const notifications = await drainTaskNotifications(ctx)
    expect(notifications.length).toBe(1)
    expect(notifications[0]).toContain(`<task_id>${agentId}</task_id>`)
    expect(notifications[0]).toContain('<task_type>agent</task_type>')
    expect(notifications[0]).toContain('<status>completed</status>')
    await flushJournal()
    const journal = await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8')
    const taskStatuses = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; task_id?: string; status?: string })
      .filter((row) => row.kind === 'task' && row.task_id === agentId)
      .map((row) => row.status)
    expect(taskStatuses).toEqual(['running', 'completed'])
    await cleanupLocalAgents(ctx)
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain(record.worktree.path)

    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({ text: 'too late', delayMs: 10_000 })
    const killedStart = await tool.call(
      { description: 'Long research', prompt: 'Wait', background: true },
      ctx,
    )
    const killedValue = killedStart.ok ? killedStart.value : undefined
    const killedId = typeof killedValue === 'object' ? killedValue.agentId : ''
    const killed = requiredAgent(killedId)
    expect(isAlive(killed.handle.pid)).toBe(true)
    const killedLogPath = killed.task.logPath ?? ''
    await cleanupTasks(ctx)
    expect(killed.task.status).toBe('killed')
    expect(isAlive(killed.handle.pid)).toBe(false)
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain(killed.worktree.path)
    await expect(fs.access(killedLogPath)).rejects.toThrow()
    const killedMessage = await new SendMessageTool().call({
      agentId: killedId,
      message: 'after cleanup',
    })
    expect(killedMessage.ok ? '' : killedMessage.error).toContain('Unknown background agent')
    await flushJournal()
    expect(await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8')).toContain(
      `"task_id":"${killedId}","type":"agent","status":"killed"`,
    )
  })

  it('delivers SendMessage at the next child turn and refuses after completion', async () => {
    const root = await makeRoot(true)
    await fs.writeFile(path.join(root, 'canary.txt'), 'message-canary')
    await git(root, 'add', 'canary.txt')
    await git(root, 'commit', '-qm', 'canary')
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({
      delayMs: 300,
      scriptedEvents: [
        [
          { type: 'tool_use', id: 'glob-1', name: 'Glob', input: { pattern: '*.txt' } },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
        [
          { type: 'text_delta', text: 'latest={{latest_user}}' },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      ],
    })
    const ctx = { repoRoot: root, messages: [], tasks: new Map() }
    backgroundContexts.push(ctx)
    const agent = new AgentTool({ systemPrompt: 'message-stable', model: 'parent-model' })
    const started = await agent.call(
      { description: 'Message target', prompt: 'Inspect files', background: true },
      ctx,
    )
    const value = started.ok ? started.value : undefined
    const agentId = typeof value === 'object' ? value.agentId : ''
    const sender = new SendMessageTool()
    expect((await sender.call({ agentId, message: 'focus on the canary' })).ok).toBe(true)

    const record = requiredAgent(agentId)
    expect((await record.result).text).toContain('latest=focus on the canary')
    const late = await sender.call({ agentId, message: 'too late' })
    expect(late.ok).toBe(false)
    expect(late.ok ? '' : late.error).toContain('completed')
    await cleanupLocalAgents(ctx)
  })

  it('one-shot runQuery kills a running agent and evicts its task log', async () => {
    const root = await makeRoot(true)
    await fs.writeFile(path.join(root, 'canary.txt'), 'one-shot-agent')
    await git(root, 'add', 'canary.txt')
    await git(root, 'commit', '-qm', 'canary')
    process.chdir(root)
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({
      text: 'must be killed at one-shot session end',
      delayMs: 10_000,
    })
    let turn = 0
    setProvider({
      name: 'anthropic',
      async *createMessageStream(): AsyncIterable<StreamEvent> {
        turn++
        if (turn === 1) {
          yield {
            type: 'tool_use',
            id: 'one-shot-background-agent',
            name: 'Agent',
            input: { description: 'Long agent', prompt: 'Wait', background: true },
          }
        } else {
          yield { type: 'text_delta', text: 'Agent launched.' }
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })
    registerPromptHandler(async () => 'allow_once')

    await runQuery('Launch an agent in the background')
    await flushJournal()

    const journal = await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8')
    const agentStatuses = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; type?: string; status?: string })
      .filter((event) => event.kind === 'task' && event.type === 'agent')
      .map((event) => event.status)
    expect(agentStatuses).toEqual(['running', 'killed'])
    const remainingLogs = await fs
      .readdir(path.join(root, '.octonoesis', 'tasks'))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
    expect(remainingLogs).toEqual([])
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain(
      'octonoesis-worktrees/agent-',
    )
  })
})
