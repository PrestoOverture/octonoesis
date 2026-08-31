import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { registerPromptHandler, unregisterPromptHandler } from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type { StreamEvent as ProviderStreamEvent } from '../../src/providers/types'
import { query } from '../../src/query'
import { MockProvider } from '../utils/mockProvider'

describe('Journal Integration Test', () => {
  const repoRoot = resolve('test/fixtures/buggy-repo')
  const tempDir = join(os.tmpdir(), `octonoesis-journal-integration-${Date.now()}`)
  const journalFile = join(tempDir, 'journal.jsonl')
  let originalMemoryDir: string | undefined

  beforeAll(async () => {
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    process.env.OCTONOESIS_MEMORY_DIR = tempDir
    await rm(tempDir, { recursive: true, force: true })
    await mkdir(tempDir, { recursive: true })
    registerPromptHandler(async () => 'allow_always')
  })

  afterAll(async () => {
    if (originalMemoryDir === undefined) {
      Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    await rm(tempDir, { recursive: true, force: true })
    setProvider(null)
    unregisterPromptHandler()
  })

  it('records chronological journal events for a multi-turn session', async () => {
    const turn1Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Let me read the buggy source file first.' },
      {
        type: 'tool_use',
        id: 'toolu_read_1',
        name: 'Read',
        input: { path: 'src/buggy.ts' },
      },
      { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
    ]

    const turn2Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Now let me list files using Glob.' },
      {
        type: 'tool_use',
        id: 'toolu_glob_2',
        name: 'Glob',
        input: { pattern: 'src/*' },
      },
      { type: 'message_end', usage: { input_tokens: 20, output_tokens: 10 } },
    ]

    const turn3Events: ProviderStreamEvent[] = [
      {
        type: 'text_delta',
        text: 'I have successfully reviewed the directory structure.',
      },
      { type: 'message_end', usage: { input_tokens: 30, output_tokens: 5 } },
    ]

    const mockProvider = new MockProvider([turn1Events, turn2Events, turn3Events])
    setProvider(mockProvider)

    // Execute query loop
    const ctx = { repoRoot }
    const generator = query('Analyze the repository structure', ctx)

    for await (const _ of generator) {
      // Consume the generator
    }

    // Verify journal.jsonl contents
    const content = await readFile(journalFile, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length > 0).toBe(true)

    const events = lines.map((line) => JSON.parse(line))

    // Check types sequence
    const kinds = events.map((e) => e.kind)
    expect(kinds.includes('user')).toBe(true)
    expect(kinds.includes('turn')).toBe(true)
    expect(kinds.includes('tool')).toBe(true)
    expect(kinds.includes('session')).toBe(true)

    // Ensure session IDs are consistent across events
    const sessionId = events[0].session_id
    expect(sessionId).toBeDefined()
    for (const e of events) {
      expect(e.session_id).toBe(sessionId)
    }

    // Verify specific properties
    const toolEvents = events.filter((e) => e.kind === 'tool')
    expect(toolEvents.length).toBe(2)
    expect(toolEvents[0].tool).toBe('Read')
    expect(toolEvents[0].outcome).toBe('success')
    expect(toolEvents[0].duration_ms >= 0).toBe(true)
    expect(toolEvents[0].input_digest).toBeDefined()

    expect(toolEvents[1].tool).toBe('Glob')

    const sessionEvent = events.find((e) => e.kind === 'session')
    expect(sessionEvent.exit_reason).toBe('completed')
    expect(sessionEvent.usage.input_tokens).toBe(60)
    expect(sessionEvent.usage.output_tokens).toBe(20)
  })
})
