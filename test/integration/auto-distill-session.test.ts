import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendEpisodes } from '../../src/memory/episodes/store.ts'
import type { Episode } from '../../src/memory/episodes/types.ts'
import { setProvider } from '../../src/providers/index.ts'
import type { CanonicalMessage, LLMProvider } from '../../src/providers/types.ts'
import { type QueryResult, type StreamEvent, query } from '../../src/query/engine.ts'
import type { QueryLoopContext } from '../../src/query/types.ts'

const originalEnv = {
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  repoRoot: process.env.OCTONOESIS_REPO_ROOT,
  disableCompact: process.env.OCTONOESIS_DISABLE_COMPACT,
}

let root = ''

function promptText(messages: CanonicalMessage[]): string {
  const content = messages[0]?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.find((block) => block.type === 'text')?.text ?? ''
}

async function collectQuery(
  generator: AsyncGenerator<StreamEvent, QueryResult, undefined>,
): Promise<QueryResult> {
  let step = await generator.next()
  while (!step.done) step = await generator.next()
  return step.value
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-auto-distill-session-'))
  process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory')
  process.env.OCTONOESIS_REPO_ROOT = root
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/bug.ts'), 'export {}\n')
})

afterEach(async () => {
  setProvider(null)
  await fs.rm(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries({
    OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
    OCTONOESIS_REPO_ROOT: originalEnv.repoRoot,
    OCTONOESIS_DISABLE_COMPACT: originalEnv.disableCompact,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

test('a failed episode distillation is attempted once across TUI-style query calls', async () => {
  const sessionId = 'shared-auto-distill-session'
  const sourceEpisode: Episode = {
    id: 'ep_0001',
    timestamp: '2026-07-16T00:00:00.000Z',
    session_id: sessionId,
    task_digest: 'fix bug',
    failure: {
      tool: 'Bash',
      cmd: 'bun test',
      error_class: 'TypeError',
      signature: 'bash|TypeError|src/bug.ts|case',
    },
    fix_candidates: [{ tool: 'Edit', path: 'src/bug.ts', summary: 'fixed', role: 'direct' }],
    attribution: { status: 'single_direct', primary: 'src/bug.ts', confidence: 0.9 },
    verification: { cmd: 'bun test', exit_code: 0 },
    outcome: 'resolved',
    journal_line_range: { start: 1, end: 3 },
    value_score: 1,
    is_excluded: false,
    exclusion_reason: null,
  }
  await appendEpisodes([sourceEpisode])
  let distillCalls = 0
  const provider: LLMProvider = {
    name: 'anthropic',
    createMessageStream: async function* (messages) {
      if (promptText(messages).includes('expert software engineering mentor')) {
        distillCalls++
        yield await Promise.reject(new Error('persistent distillation failure'))
        return
      }
      yield await Promise.reject(new Error('synthetic main-query failure'))
    },
  }
  setProvider(provider)
  const ctx: QueryLoopContext = { repoRoot: root, sessionId, messages: [], tasks: new Map() }

  const first = await collectQuery(query('first query', ctx))
  const second = await collectQuery(query('second query', ctx))

  expect(first.exit_reason).toBe('fatal_error')
  expect(second.exit_reason).toBe('fatal_error')
  expect(distillCalls).toBe(1)
  expect(ctx.autoDistillAttemptedEpisodeIds).toEqual(new Set([sourceEpisode.id]))
})
