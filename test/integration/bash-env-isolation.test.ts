import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { QueryLoopContext, TaskState } from '../../src/query/types'
import { cleanupTasks } from '../../src/tasks/framework'
import { bashTool } from '../../src/tools/Bash'

const CREDENTIAL_COMMAND = `printf '%s|%s' "$ANTHROPIC_API_KEY" "$OPENAI_API_KEY"`
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY
const originalOpenAiKey = process.env.OPENAI_API_KEY
const originalOptOut = process.env.OCTONOESIS_INHERIT_API_KEYS
let repoRoot = ''
const contexts: QueryLoopContext[] = []

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key)
  else process.env[key] = value
}

async function waitForTerminalTask(task: TaskState): Promise<void> {
  const deadline = Date.now() + 5_000
  while (task.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (task.status === 'running') throw new Error(`Timed out waiting for task ${task.id}`)
}

async function foregroundOutput(ctx: QueryLoopContext): Promise<string> {
  const result = await bashTool.call({ command: CREDENTIAL_COMMAND }, ctx)
  if (!result.ok) throw new Error(result.error)
  return (JSON.parse(result.value) as { stdout: string }).stdout
}

async function backgroundOutput(ctx: QueryLoopContext): Promise<string> {
  const result = await bashTool.call({ command: CREDENTIAL_COMMAND, run_in_background: true }, ctx)
  if (!result.ok) throw new Error(result.error)
  const { task_id: taskId } = JSON.parse(result.value) as { task_id: string }
  const task = ctx.tasks?.get(taskId)
  if (!task?.logPath) throw new Error(`Missing background shell task ${taskId}`)
  await waitForTerminalTask(task)
  return fs.readFile(task.logPath, 'utf8')
}

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-bash-env-'))
  process.env.ANTHROPIC_API_KEY = 'anthropic-test-secret'
  process.env.OPENAI_API_KEY = 'openai-test-secret'
  Reflect.deleteProperty(process.env, 'OCTONOESIS_INHERIT_API_KEYS')
})

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map((ctx) => cleanupTasks(ctx)))
  await fs.rm(repoRoot, { recursive: true, force: true })
  restoreEnv('ANTHROPIC_API_KEY', originalAnthropicKey)
  restoreEnv('OPENAI_API_KEY', originalOpenAiKey)
  restoreEnv('OCTONOESIS_INHERIT_API_KEYS', originalOptOut)
})

describe('Bash credential environment isolation', () => {
  it('strips known API keys from foreground and background commands by default', async () => {
    const foregroundCtx: QueryLoopContext = { repoRoot, tasks: new Map() }
    const backgroundCtx: QueryLoopContext = { repoRoot, tasks: new Map() }
    contexts.push(foregroundCtx, backgroundCtx)

    expect(await foregroundOutput(foregroundCtx)).toBe('|')
    expect(await backgroundOutput(backgroundCtx)).toBe('|')
  })

  it('preserves known API keys when the explicit opt-out is enabled', async () => {
    process.env.OCTONOESIS_INHERIT_API_KEYS = '1'
    const foregroundCtx: QueryLoopContext = { repoRoot, tasks: new Map() }
    const backgroundCtx: QueryLoopContext = { repoRoot, tasks: new Map() }
    contexts.push(foregroundCtx, backgroundCtx)

    expect(await foregroundOutput(foregroundCtx)).toBe('anthropic-test-secret|openai-test-secret')
    expect(await backgroundOutput(backgroundCtx)).toBe('anthropic-test-secret|openai-test-secret')
  })
})
