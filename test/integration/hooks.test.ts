// biome-ignore lint/suspicious/noExplicitAny: Bun.main is writable in the test runtime.
declare const Bun: any

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { flushJournal } from '../../src/memory/journal'
import { registerPromptHandler, unregisterPromptHandler } from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type { CanonicalMessage, LLMProvider, StreamEvent } from '../../src/providers/types'
import { query } from '../../src/query'
import { flushSessionStats } from '../../src/state/session'

const testWithTimeout = test as unknown as (
  name: string,
  fn: () => Promise<void>,
  timeoutMs: number,
) => void

const originalEnv = {
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
  compactThreshold: process.env.OCTONOESIS_COMPACT_THRESHOLD,
  disableCompact: process.env.OCTONOESIS_DISABLE_COMPACT,
  forkMock: process.env.OCTONOESIS_FORK_MOCK,
}
const originalMain = Bun.main
let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hooks-integration-'))
  Bun.main = path.resolve('src/cli.tsx')
  process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'state')
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
})

afterEach(async () => {
  setProvider(null)
  unregisterPromptHandler()
  Bun.main = originalMain
  await flushJournal()
  await rm(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries({
    OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
    OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
    OCTONOESIS_COMPACT_THRESHOLD: originalEnv.compactThreshold,
    OCTONOESIS_DISABLE_COMPACT: originalEnv.disableCompact,
    OCTONOESIS_FORK_MOCK: originalEnv.forkMock,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

async function drain(generator: ReturnType<typeof query>): Promise<void> {
  for await (const _event of generator) {
    // Drain the query through its lifecycle hooks.
  }
}

describe('config-driven lifecycle hooks', () => {
  test('pre_tool_use blocks Bash before permission/spawn and post_tool_use receives the failure', async () => {
    const configDir = path.join(root, '.octonoesis')
    const prePayload = path.join(root, 'pre.json')
    const postPayload = path.join(root, 'post.json')
    const forbidden = path.join(root, 'must-not-exist.txt')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        hooks: [
          {
            event: 'pre_tool_use',
            toolPattern: 'Bash',
            command: `cat > '${prePayload}'; echo denied-by-hook >&2; exit 2`,
          },
          {
            event: 'post_tool_use',
            toolPattern: 'Bash',
            command: `cat > '${postPayload}'`,
          },
        ],
      }),
    )
    let turn = 0
    let sawDeniedToolResult = false
    let sawIsError = false
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(messages: CanonicalMessage[]): AsyncIterable<StreamEvent> {
        if (turn++ === 0) {
          yield {
            type: 'tool_use',
            id: 'blocked-bash',
            name: 'Bash',
            input: { command: `touch '${forbidden}'` },
          }
        } else {
          const last = messages.at(-1)
          sawDeniedToolResult = JSON.stringify(last).includes('denied-by-hook')
          sawIsError =
            last?.role === 'tool' &&
            Array.isArray(last.content) &&
            last.content.some((block) => block.type === 'tool_result' && block.is_error === true)
          yield { type: 'text_delta', text: 'finished after denial' }
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)
    let prompted = false
    registerPromptHandler(async () => {
      prompted = true
      return 'allow_once'
    })

    await drain(query('try the configured hook', { repoRoot: root }))
    await flushJournal()

    expect(prompted).toBe(false)
    let forbiddenExists = true
    try {
      await access(forbidden)
    } catch {
      forbiddenExists = false
    }
    expect(forbiddenExists).toBe(false)
    expect(sawDeniedToolResult).toBe(true)
    expect(sawIsError).toBe(true)
    const pre = JSON.parse(await readFile(prePayload, 'utf8'))
    expect(pre.event).toBe('pre_tool_use')
    expect(pre.tool).toBe('Bash')
    expect(pre.input).toEqual({ command: `touch '${forbidden}'` })
    expect(typeof pre.sessionId).toBe('string')
    const post = JSON.parse(await readFile(postPayload, 'utf8'))
    expect(post.event).toBe('post_tool_use')
    expect(post.tool).toBe('Bash')
    expect(post.outcome.ok).toBe(false)
    expect(post.outcome.error).toContain('denied-by-hook')
    const journal = (await readFile(path.join(root, 'state/journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const shellHooks = journal.filter(
      (event) => event.kind === 'hook' && event.hook_type === 'shell',
    )
    expect(shellHooks.map((event) => event.hook_event)).toEqual(['pre_tool_use', 'post_tool_use'])
    expect(shellHooks.every((event) => event.schema_version === 2)).toBe(true)
  })

  test('runs post_tool_use after an approved Bash spawn with its result payload', async () => {
    const configDir = path.join(root, '.octonoesis')
    const spawned = path.join(root, 'spawned.txt')
    const hookLog = path.join(root, 'post-hook.json')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        hooks: [
          {
            event: 'post_tool_use',
            toolPattern: 'Bash',
            command: `test -f '${spawned}' && cat > '${hookLog}'`,
          },
        ],
      }),
    )
    let turn = 0
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(): AsyncIterable<StreamEvent> {
        if (turn++ === 0) {
          yield {
            type: 'tool_use',
            id: 'approved-bash',
            name: 'Bash',
            input: { command: `printf spawned > '${spawned}'` },
          }
        } else {
          yield { type: 'text_delta', text: 'bash and post hook finished' }
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)
    const promptedTools: string[] = []
    registerPromptHandler(async (toolName) => {
      promptedTools.push(toolName)
      return 'allow_once'
    })

    await drain(query('run approved Bash', { repoRoot: root }))

    expect(promptedTools).toEqual(['Bash'])
    expect(await readFile(spawned, 'utf8')).toBe('spawned')
    const payload = JSON.parse(await readFile(hookLog, 'utf8'))
    expect(payload.event).toBe('post_tool_use')
    expect(payload.tool).toBe('Bash')
    expect(payload.outcome.ok).toBe(true)
    expect(JSON.parse(payload.outcome.value).code).toBe(0)
  })

  test('fires session_start, compact, stop, and session_end in lifecycle order', async () => {
    const configDir = path.join(root, '.octonoesis')
    const eventLog = path.join(root, 'events.log')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        hooks: ['session_start', 'compact', 'stop', 'session_end'].map((event) => ({
          event,
          command: `cat > /dev/null; printf '%s\\n' "$OCTONOESIS_HOOK_EVENT" >> '${eventLog}'`,
        })),
      }),
    )
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({ text: 'hook compact summary' })
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
    let turn = 0
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(): AsyncIterable<StreamEvent> {
        turn++
        if (turn <= 3) {
          yield {
            type: 'tool_use',
            id: `read-${turn}`,
            name: 'Read',
            input: { path: 'package.json' },
          }
          yield { type: 'message_end', usage: { input_tokens: 5_000, output_tokens: 10 } }
          return
        }
        yield { type: 'text_delta', text: 'done' }
        yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 2 } }
      },
    }
    setProvider(provider)

    await drain(query('exercise all lifecycle mounts', { repoRoot: root }))
    await flushJournal()
    await flushSessionStats()

    expect((await readFile(eventLog, 'utf8')).trim().split('\n')).toEqual([
      'session_start',
      'compact',
      'stop',
      'session_end',
    ])
    const journal = (await readFile(path.join(root, 'state/journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    for (const event of ['session_start', 'compact', 'stop', 'session_end']) {
      expect(
        journal.some(
          (row) =>
            row.kind === 'hook' &&
            row.hook_type === 'shell' &&
            row.hook_event === event &&
            row.schema_version === 2,
        ),
      ).toBe(true)
    }
    const functionHooks = journal.filter(
      (row) => row.kind === 'hook' && row.hook_type === 'function',
    )
    expect(functionHooks.map((row) => row.hook_event)).toEqual(['stop', 'session_end'])
    expect(
      functionHooks.every((row) => row.outcome === 'success' && row.schema_version === 2),
    ).toBe(true)
    expect((await readFile(path.join(root, 'state/stats.jsonl'), 'utf8')).trim()).not.toBe('')
  })

  testWithTimeout(
    'caps a 30-second shell hook near five seconds and completes normally',
    async () => {
      const configDir = path.join(root, '.octonoesis')
      await mkdir(configDir, { recursive: true })
      await writeFile(
        path.join(configDir, 'config.json'),
        JSON.stringify({ hooks: [{ event: 'stop', command: 'sleep 30' }] }),
      )
      const provider: LLMProvider = {
        name: 'anthropic',
        async *createMessageStream(): AsyncIterable<StreamEvent> {
          yield { type: 'text_delta', text: 'normal completion' }
          yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
        },
      }
      setProvider(provider)
      const started = performance.now()
      const generator = query('exercise slow hook', { repoRoot: root })
      let step = await generator.next()
      while (!step.done) step = await generator.next()
      const duration = performance.now() - started
      await flushJournal()

      expect(step.value.exit_reason).toBe('completed')
      expect(step.value.final_message).toBe('normal completion')
      expect(duration).toBeGreaterThan(4_500)
      expect(duration).toBeLessThan(7_000)
      const journal = (await readFile(path.join(root, 'state/journal.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(
        journal.some(
          (event) =>
            event.kind === 'hook' &&
            event.hook_event === 'stop' &&
            event.hook_type === 'shell' &&
            event.outcome === 'timeout' &&
            event.schema_version === 2,
        ),
      ).toBe(true)
    },
    10_000,
  )
})
