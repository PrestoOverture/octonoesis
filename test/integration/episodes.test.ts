import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { readEpisodes } from '../../src/memory/episodes/store'
import { registerPromptHandler, unregisterPromptHandler } from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type {
  CanonicalMessage,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
} from '../../src/providers/types'
import { query } from '../../src/query'

describe('Episode Integration Loop', () => {
  let tempDir = ''
  let memoryDir = ''
  let tempFilePath = ''
  let originalMemoryDir: string | undefined

  beforeAll(async () => {
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    const rawTempDir = join(os.tmpdir(), `octonoesis-ep-integration-${Date.now()}`)
    await rm(rawTempDir, { recursive: true, force: true })
    await mkdir(join(rawTempDir, 'src'), { recursive: true })

    const { realpath } = await import('node:fs/promises')
    tempDir = await realpath(rawTempDir)
    memoryDir = join(tempDir, '.octonoesis')
    tempFilePath = join(tempDir, 'src/temp.ts')

    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    await mkdir(memoryDir, { recursive: true })

    // Create a mock source file
    await writeFile(tempFilePath, 'original content', 'utf8')

    // Auto-approve command executions in tests
    registerPromptHandler(async () => 'allow_always')
  })

  afterAll(async () => {
    if (originalMemoryDir === undefined) {
      process.env.OCTONOESIS_MEMORY_DIR = undefined
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
    setProvider(null)
    unregisterPromptHandler()
  })

  it('runs query loop E2E, segments failure and fix, and persists the episode', async () => {
    const turn1Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Let me run the failing test first.' },
      {
        type: 'tool_use',
        id: 'toolu_bash_1',
        name: 'Bash',
        input: { command: "echo 'TypeError: null pointer in src/temp.ts:2' >&2 && exit 1" },
      },
      { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
    ]

    const turn2Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'I need to read the file first before editing.' },
      {
        type: 'tool_use',
        id: 'toolu_read_2',
        name: 'Read',
        input: { path: 'src/temp.ts' },
      },
      { type: 'message_end', usage: { input_tokens: 20, output_tokens: 10 } },
    ]

    const turn3Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Now I will apply the fix.' },
      {
        type: 'tool_use',
        id: 'toolu_edit_3',
        name: 'Edit',
        input: {
          path: 'src/temp.ts',
          old_string: 'original content',
          new_string: 'fixed content',
        },
      },
      { type: 'message_end', usage: { input_tokens: 30, output_tokens: 15 } },
    ]

    const turn4Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Let me run the tests again to verify.' },
      {
        type: 'tool_use',
        id: 'toolu_bash_4',
        name: 'Bash',
        input: { command: 'exit 0' },
      },
      { type: 'message_end', usage: { input_tokens: 40, output_tokens: 20 } },
    ]

    const turn5Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Perfect. The error is resolved.' },
      { type: 'message_end', usage: { input_tokens: 50, output_tokens: 5 } },
    ]

    // Custom Mock Provider for playback
    let currentTurn = 0
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
            if (
              firstBlock &&
              'type' in firstBlock &&
              firstBlock.type === 'text' &&
              'text' in firstBlock
            ) {
              firstMsgText = (firstBlock as { text: string }).text
            }
          }
        }

        if (firstMsgText.includes('precise tool execution error analyzer')) {
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              tool: 'Bash',
              error_class: 'TypeError',
              file: 'src/temp.ts',
              expression: 'null pointer',
            }),
          }
          yield {
            type: 'message_end',
            usage: { input_tokens: 5, output_tokens: 5 },
          }
          return
        }

        currentTurn++
        const turnQueue = [turn1Events, turn2Events, turn3Events, turn4Events, turn5Events]
        const events = turnQueue[currentTurn - 1] || []
        for (const ev of events) {
          yield ev
        }
      },
    }
    setProvider(mockProvider)

    const ctx = { repoRoot: tempDir }
    const generator = query('Fix the error in src/temp.ts', ctx)

    for await (const _event of generator) {
      // Consume all events to let query run to completion
    }

    // After query runs, the finally block will have processed the session-end hook and persisted episodes.
    const episodes = await readEpisodes()
    expect(episodes.length).toBe(1)

    const ep = episodes[0]
    expect(ep).toBeDefined()
    expect(ep?.outcome).toBe('resolved')
    expect(ep?.failure.tool).toBe('Bash')
    expect(ep?.failure.error_class).toBe('TypeError')
    expect(ep?.fix?.path).toBe('src/temp.ts')
    expect(ep?.value_score).toBe(1.0)
    expect(ep?.is_excluded).toBe(false)
  })
})
