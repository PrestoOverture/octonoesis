import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { rebuildRules } from '../../src/memory/rules/rebuild'
import { loadRule } from '../../src/memory/rules/store'
import { registerPromptHandler, unregisterPromptHandler } from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type { LLMProvider, StreamEvent as ProviderStreamEvent } from '../../src/providers/types'
import { query } from '../../src/query'

// Global variables for mocking
let tempDir = ''
let memoryDir = ''
let tempFilePath = ''
let originalMemoryDir: string | undefined
let originalRepoRoot: string | undefined
// biome-ignore lint/suspicious/noExplicitAny: Bun process handle mock
let originalSpawn: any = null

// Global object to feed mock test runner results
const mockSpawnResults: Record<string, { exitCode: number; stdout: string; stderr: string }[]> = {}

describe('End-to-End Learning Loop', () => {
  beforeAll(async () => {
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    originalRepoRoot = process.env.OCTONOESIS_REPO_ROOT
    const rawTempDir = join(os.tmpdir(), `octonoesis-learning-loop-${Date.now()}`)
    await rm(rawTempDir, { recursive: true, force: true })
    await mkdir(join(rawTempDir, 'src'), { recursive: true })

    const { realpath } = await import('node:fs/promises')
    tempDir = await realpath(rawTempDir)
    memoryDir = join(tempDir, '.octonoesis')
    tempFilePath = join(tempDir, 'src/buggy.ts')

    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    process.env.OCTONOESIS_REPO_ROOT = tempDir
    await mkdir(memoryDir, { recursive: true })

    // Create buggy source file
    await writeFile(tempFilePath, 'original buggy content', 'utf8')

    // Auto-approve command executions in tests
    registerPromptHandler(async () => 'allow_always')

    // Mock Bun.spawn globally to intercept child processes
    // biome-ignore lint/suspicious/noExplicitAny: Bun global object
    originalSpawn = (globalThis as any).Bun.spawn
    // biome-ignore lint/suspicious/noExplicitAny: Bun global object
    ;(globalThis as any).Bun.spawn = (options: any) => {
      const command = options.cmd[2]
      const mockList = mockSpawnResults[command]
      if (mockList && mockList.length > 0) {
        const mockResult = mockList.shift()
        if (!mockResult) {
          return originalSpawn(options)
        }
        return {
          pid: 12345,
          stdout: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(mockResult.stdout))
              controller.close()
            },
          }),
          stderr: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(mockResult.stderr))
              controller.close()
            },
          }),
          exited: Promise.resolve(mockResult.exitCode),
          kill: () => {},
        }
      }
      return originalSpawn(options)
    }
  })

  afterAll(async () => {
    // Restore environment variables
    if (originalMemoryDir === undefined) {
      process.env.OCTONOESIS_MEMORY_DIR = undefined
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    if (originalRepoRoot === undefined) {
      process.env.OCTONOESIS_REPO_ROOT = undefined
    } else {
      process.env.OCTONOESIS_REPO_ROOT = originalRepoRoot
    }

    // Restore global Bun.spawn
    if (originalSpawn) {
      // biome-ignore lint/suspicious/noExplicitAny: Bun global object
      ;(globalThis as any).Bun.spawn = originalSpawn
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
    setProvider(null)
    unregisterPromptHandler()
  })

  it('completes the 2-session learning loop successfully', async () => {
    // ----------------------------------------------------
    // SESSION 1 MOCK STREAM EVENTS
    // ----------------------------------------------------
    const s1Turn1Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Let me run the failing test to see the error.' },
      {
        type: 'tool_use',
        id: 's1_toolu_bash_1',
        name: 'Bash',
        input: { command: 'bun test' },
      },
      { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
    ]

    const s1Turn2Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Reading file to understand structure.' },
      {
        type: 'tool_use',
        id: 's1_toolu_read_2',
        name: 'Read',
        input: { path: 'src/buggy.ts' },
      },
      { type: 'message_end', usage: { input_tokens: 20, output_tokens: 10 } },
    ]

    const s1Turn3Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Editing file to apply fix.' },
      {
        type: 'tool_use',
        id: 's1_toolu_edit_3',
        name: 'Edit',
        input: {
          path: 'src/buggy.ts',
          old_string: 'original buggy content',
          new_string: 'fixed content',
        },
      },
      { type: 'message_end', usage: { input_tokens: 30, output_tokens: 15 } },
    ]

    const s1Turn4Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Verifying test passes.' },
      {
        type: 'tool_use',
        id: 's1_toolu_bash_4',
        name: 'Bash',
        input: { command: 'bun test' },
      },
      { type: 'message_end', usage: { input_tokens: 40, output_tokens: 20 } },
    ]

    const s1Turn5Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Fixed error successfully!' },
      { type: 'message_end', usage: { input_tokens: 50, output_tokens: 5 } },
    ]

    // ----------------------------------------------------
    // SESSION 2 MOCK STREAM EVENTS (Same repo, similar failure)
    // ----------------------------------------------------
    const s2Turn1Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Running test to see the failure.' },
      {
        type: 'tool_use',
        id: 's2_toolu_bash_1',
        name: 'Bash',
        input: { command: 'bun test' },
      },
      { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
    ]

    const s2Turn2Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'I received the injected rule. Applying optional chaining fix.' },
      {
        type: 'tool_use',
        id: 's2_toolu_edit_2',
        name: 'Edit',
        input: {
          path: 'src/buggy.ts',
          old_string: 'another buggy content',
          new_string: 'fixed option content',
        },
      },
      { type: 'message_end', usage: { input_tokens: 30, output_tokens: 15 } },
    ]

    const s2Turn3Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Verifying fix.' },
      {
        type: 'tool_use',
        id: 's2_toolu_bash_3',
        name: 'Bash',
        input: { command: 'bun test' },
      },
      { type: 'message_end', usage: { input_tokens: 40, output_tokens: 20 } },
    ]

    const s2Turn4Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Task completed successfully!' },
      { type: 'message_end', usage: { input_tokens: 50, output_tokens: 5 } },
    ]

    let s1Turn = 0
    let s2Turn = 0
    let currentSession = 1

    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* (messages) {
        let firstMsgText = ''
        const firstMsg = messages[0]
        if (firstMsg) {
          if (typeof firstMsg.content === 'string') {
            firstMsgText = firstMsg.content
          } else if (Array.isArray(firstMsg.content)) {
            const firstBlock = firstMsg.content[0]
            if (firstBlock && 'type' in firstBlock && firstBlock.type === 'text') {
              firstMsgText = (firstBlock as { text: string }).text
            }
          }
        }

        // 1. LLM Error Fingerprint Extractor Mock
        if (firstMsgText.includes('precise tool execution error analyzer')) {
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              tool: 'bun-test',
              error_class: 'TypeError',
              file: 'src/buggy.ts',
              expression: "evaluating 'user.name'",
            }),
          }
          yield {
            type: 'message_end',
            usage: { input_tokens: 5, output_tokens: 5 },
          }
          return
        }

        // 2. LLM Rule Distiller Mock
        if (firstMsgText.includes('distill a reusable coding rule from it')) {
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              slug: 'optional-chaining-buggy',
              triggers: {
                tools: ['Bash'],
                command_prefix: ['bun test'],
                error_signatures: ["bun-test|TypeError|src/buggy.ts|evaluating 'user.name'"],
              },
              anchor_file: 'src/buggy.ts',
              advice: 'Use optional chaining in src/buggy.ts to prevent TypeError.',
            }),
          }
          yield {
            type: 'message_end',
            usage: { input_tokens: 5, output_tokens: 5 },
          }
          return
        }

        // 3. Session 1 Execution
        if (currentSession === 1) {
          s1Turn++
          const queue = [s1Turn1Events, s1Turn2Events, s1Turn3Events, s1Turn4Events, s1Turn5Events]
          const events = queue[s1Turn - 1] || []
          for (const ev of events) {
            yield ev
          }
          return
        }

        // 4. Session 2 Execution
        if (currentSession === 2) {
          s2Turn++

          // Verify that during Turn 2 (after Bash failed in Turn 1), the matched rule was injected!
          if (s2Turn === 2) {
            const lastMsg = messages[messages.length - 1]
            let lastMsgContent = ''
            if (lastMsg) {
              lastMsgContent =
                typeof lastMsg.content === 'string'
                  ? lastMsg.content
                  : JSON.stringify(lastMsg.content)
            }
            expect(lastMsgContent).toContain('<octo-memory>')
            expect(lastMsgContent).toContain(
              'Use optional chaining in src/buggy.ts to prevent TypeError.',
            )
          }

          const queue = [s2Turn1Events, s2Turn2Events, s2Turn3Events, s2Turn4Events]
          const events = queue[s2Turn - 1] || []
          for (const ev of events) {
            yield ev
          }
        }
      },
    }
    setProvider(mockProvider)

    // Set mock spawn results for Session 1
    mockSpawnResults['bun test'] = [
      { exitCode: 1, stdout: 'TypeError: user.name is undefined at src/buggy.ts:1', stderr: '' },
      { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    ]

    const ctx1 = { repoRoot: tempDir }
    // biome-ignore lint/suspicious/noExplicitAny: mock context type bypass
    const generator1 = query('Fix error in src/buggy.ts', ctx1 as any)
    for await (const _event of generator1) {
    }

    // ----------------------------------------------------
    // DISTILL RULES FROM EPISODES
    // ----------------------------------------------------
    await rebuildRules(join(memoryDir, 'episodes.jsonl'), join(memoryDir, 'rules'), {
      model: 'mock-model',
      extractorVersion: '0.2.0',
    })

    // Verify candidate rule was written to disk
    const rule1 = await loadRule('rule-optional-chaining-buggy')
    expect(rule1).toBeDefined()
    expect(rule1?.status).toBe('candidate')
    expect(rule1?.confidence).toBe(0.6) // confidence default on 1 evidence is 0.60
    expect(rule1?.hits).toBe(0)
    expect(rule1?.misses).toBe(0)

    // ====================================================
    // RUN SESSION 2: Re-encounter similar error -> Injects rule -> Fixes -> Hit
    // =================================--------------------
    currentSession = 2
    await writeFile(tempFilePath, 'another buggy content', 'utf8') // Reset file

    // Set mock spawn results for Session 2
    mockSpawnResults['bun test'] = [
      { exitCode: 1, stdout: 'TypeError: user.name is undefined at src/buggy.ts:1', stderr: '' },
      { exitCode: 0, stdout: 'All tests passed', stderr: '' },
    ]

    const ctx2 = { repoRoot: tempDir }
    // biome-ignore lint/suspicious/noExplicitAny: mock context type bypass
    const generator2 = query('Fix typo in src/buggy.ts', ctx2 as any)
    for await (const _event of generator2) {
    }

    // Verify the rule was updated and promoted to active with hits = 1 and confidence = 0.71
    const rule2 = await loadRule('rule-optional-chaining-buggy')
    expect(rule2).toBeDefined()
    expect(rule2?.status).toBe('active')
    expect(rule2?.hits).toBe(1)
    expect(rule2?.misses).toBe(0)
    expect(rule2?.confidence).toBe(0.7143) // (1 + 0.5 * 1 + 1) / (1 + 0 + 0.5 * 1 + 2) = 2.5 / 3.5 = 0.7143
  })
})
