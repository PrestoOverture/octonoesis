import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearConfigCacheForTests } from '../../src/config/load'
import { flushJournal } from '../../src/memory/journal'
import { setConfiguredModel, setProvider } from '../../src/providers'
import type { CanonicalTool, LLMProvider } from '../../src/providers/types'
import { query } from '../../src/query'
import type { QueryResult, StreamEvent } from '../../src/query/engine'
import type { QueryLoopContext } from '../../src/query/types'

// biome-ignore lint/suspicious/noExplicitAny: Bun.file is provided by the test runtime.
declare const Bun: any
import { parseConfig } from '../../src/config/schema'
import { registerPromptHandler, unregisterPromptHandler } from '../../src/permissions/confirm'
import { buildSessionContextSources } from '../../src/prompts/context'

const originalEnv = {
  model: process.env.MODEL,
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
  disableCompact: process.env.OCTONOESIS_DISABLE_COMPACT,
}
let root = ''

async function collect(
  generator: AsyncGenerator<StreamEvent, QueryResult, undefined>,
): Promise<QueryResult> {
  let step = await generator.next()
  while (!step.done) step = await generator.next()
  return step.value
}

async function writeConfig(value: unknown): Promise<void> {
  const configPath = path.join(root, '.octonoesis', 'config.json')
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(value))
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'config-system-'))
  process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'state')
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
  Reflect.deleteProperty(process.env, 'MODEL')
})

afterEach(async () => {
  setProvider(null)
  setConfiguredModel(undefined)
  unregisterPromptHandler()
  clearConfigCacheForTests()
  await flushJournal()
  await rm(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries({
    MODEL: originalEnv.model,
    OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
    OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
    OCTONOESIS_DISABLE_COMPACT: originalEnv.disableCompact,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

describe('unified config wiring', () => {
  test('config model reaches session state while MODEL wins over it', async () => {
    await writeConfig({ model: 'config-model' })
    const observed: string[] = []
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(
        _messages,
        _tools: CanonicalTool[],
        options: Parameters<LLMProvider['createMessageStream']>[2],
      ) {
        observed.push(options.model)
        yield { type: 'text_delta' as const, text: 'done' }
        yield { type: 'message_end' as const, usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)
    const ctx: QueryLoopContext = { repoRoot: root }
    await collect(query('use configured model', ctx))
    expect(observed).toEqual(['config-model'])
    expect(ctx.sessionState?.model).toBe('config-model')

    process.env.MODEL = 'env-model'
    const envCtx: QueryLoopContext = { repoRoot: root }
    await collect(query('use env model', envCtx))
    expect(observed.at(-1)).toBe('env-model')
    expect(envCtx.sessionState?.model).toBe('env-model')
  })

  test('maxTurns from config caps the session at two turns', async () => {
    await writeConfig({ maxTurns: 2 })
    let calls = 0
    setProvider({
      name: 'anthropic',
      async *createMessageStream() {
        calls++
        yield {
          type: 'tool_use' as const,
          id: `read-${calls}`,
          name: 'Read',
          input: { path: 'package.json' },
        }
        yield { type: 'message_end' as const, usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })

    const result = await collect(query('keep reading', { repoRoot: root }))
    expect(result.exit_reason).toBe('max_turns')
    expect(result.turns).toBe(2)
    expect(calls).toBe(2)
  })

  test('OCTONOESIS.md displaces CLAUDE.md and projectInstructions off omits both', async () => {
    await writeFile(path.join(root, 'CLAUDE.md'), 'CLAUDE_ONLY_CANARY')
    await writeFile(path.join(root, 'OCTONOESIS.md'), 'OCTONOESIS_ONLY_CANARY')

    const enabled = await buildSessionContextSources(
      { repoRoot: root, config: parseConfig({}) },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
    )
    const enabledText = enabled.map((source) => source.content).join('\n')
    expect(enabledText).toContain('OCTONOESIS_ONLY_CANARY')
    expect(enabledText).not.toContain('CLAUDE_ONLY_CANARY')

    const disabled = await buildSessionContextSources(
      { repoRoot: root, config: parseConfig({ projectInstructions: 'off' }) },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
    )
    const disabledText = disabled.map((source) => source.content).join('\n')
    expect(disabledText).not.toContain('OCTONOESIS_ONLY_CANARY')
    expect(disabledText).not.toContain('CLAUDE_ONLY_CANARY')
  })

  test('a config deny blocks the tool without prompting and journals via config', async () => {
    await writeConfig({ permissions: { denyPatterns: ['Write'] } })
    const forbidden = path.join(root, 'forbidden.txt')
    let turn = 0
    setProvider({
      name: 'anthropic',
      async *createMessageStream() {
        if (turn++ === 0) {
          yield {
            type: 'tool_use' as const,
            id: 'write-denied',
            name: 'Write',
            input: { path: 'forbidden.txt', content: 'blocked' },
          }
        } else yield { type: 'text_delta' as const, text: 'done' }
        yield { type: 'message_end' as const, usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })
    let prompted = false
    registerPromptHandler(async () => {
      prompted = true
      return 'allow_once'
    })

    await collect(query('deny write', { repoRoot: root }))
    await flushJournal()
    expect(prompted).toBe(false)
    expect(await Bun.file(forbidden).exists()).toBe(false)
    const rows = (await readFile(path.join(root, 'state', 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(
      rows.some(
        (row) => row.kind === 'permission' && row.decision === 'deny' && row.via === 'config',
      ),
    ).toBe(true)
  })

  test('a config allow pattern skips the prompt and executes the tool', async () => {
    await writeConfig({ permissions: { allowPatterns: ['Bash(printf*)'] } })
    const output = path.join(root, 'allowed.txt')
    let turn = 0
    setProvider({
      name: 'anthropic',
      async *createMessageStream() {
        if (turn++ === 0) {
          yield {
            type: 'tool_use' as const,
            id: 'bash-allowed',
            name: 'Bash',
            input: { command: `printf allowed > '${output}'` },
          }
        } else yield { type: 'text_delta' as const, text: 'done' }
        yield { type: 'message_end' as const, usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })
    let prompted = false
    registerPromptHandler(async () => {
      prompted = true
      return 'deny'
    })

    await collect(query('allow bash', { repoRoot: root }))
    expect(prompted).toBe(false)
    expect(await readFile(output, 'utf8')).toBe('allowed')
  })

  test('CLI reports a typoed key before checking API credentials', async () => {
    await writeConfig({ typoedSetting: true })
    const child = Bun.spawn({
      cmd: [process.execPath, path.resolve('src/cli.tsx'), 'probe'],
      cwd: root,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(code).not.toBe(0)
    expect(stderr).toContain('typoedSetting: unrecognized key')
    expect(stderr).not.toContain('ANTHROPIC_API_KEY is not set')
  })
})
