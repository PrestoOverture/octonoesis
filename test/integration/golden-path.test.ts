import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { registerPromptHandler, unregisterPromptHandler } from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type { StreamEvent as ProviderStreamEvent } from '../../src/providers/types'
import { query } from '../../src/query'
import type { StreamEvent } from '../../src/query'
import { MockProvider } from '../utils/mockProvider'

describe('Golden Path E2E Integration', () => {
  const repoRoot = resolve('test/fixtures/buggy-repo')
  const buggyPath = resolve(repoRoot, 'src/buggy.ts')
  let originalBuggyContent: string

  beforeAll(async () => {
    // Save original buggy file content to restore it later
    originalBuggyContent = await readFile(buggyPath, 'utf-8')
    // Auto-approve all modifying tools (Edit, Bash)
    registerPromptHandler(async () => 'allow_always')
  })

  afterAll(async () => {
    // Restore original buggy file content
    await writeFile(buggyPath, originalBuggyContent, 'utf-8')
    // Reset provider and prompts
    setProvider(null)
    unregisterPromptHandler()
  })

  it('runs the multi-turn agent flow to detect, edit, and test a bug fix', async () => {
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
      { type: 'text_delta', text: 'Now let me check the test file using Grep.' },
      {
        type: 'tool_use',
        id: 'toolu_grep_2',
        name: 'Grep',
        input: { pattern: 'handleUser', path: 'src' },
      },
      { type: 'message_end', usage: { input_tokens: 20, output_tokens: 10 } },
    ]

    const turn3Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'I see the bug. I will edit the file to add a null guard.' },
      {
        type: 'tool_use',
        id: 'toolu_edit_3',
        name: 'Edit',
        input: {
          path: 'src/buggy.ts',
          old_string:
            '  // @ts-ignore - Intentionally buggy for testing, ignoring compiler error\n  return `Hello, ${user.name.toUpperCase()}!`',
          new_string:
            "  if (!user || !user.name) {\n    return 'Hello, Guest!'\n  }\n  return `Hello, ${user.name.toUpperCase()}!`",
        },
      },
      { type: 'message_end', usage: { input_tokens: 30, output_tokens: 15 } },
    ]

    const turn4Events: ProviderStreamEvent[] = [
      { type: 'text_delta', text: 'Now let me run the tests via Bash to verify the fix.' },
      {
        type: 'tool_use',
        id: 'toolu_bash_4',
        name: 'Bash',
        input: { command: 'bun test' },
      },
      { type: 'message_end', usage: { input_tokens: 40, output_tokens: 20 } },
    ]

    const turn5Events: ProviderStreamEvent[] = [
      {
        type: 'text_delta',
        text: 'All 5 tests pass successfully. The null pointer bug has been fixed!',
      },
      { type: 'message_end', usage: { input_tokens: 50, output_tokens: 10 } },
    ]

    // Set the MockProvider
    const mockProvider = new MockProvider([
      turn1Events,
      turn2Events,
      turn3Events,
      turn4Events,
      turn5Events,
    ])
    setProvider(mockProvider)

    // Execute query loop
    const ctx = { repoRoot }
    const generator = query('Fix the bug in src/buggy.ts and run tests to verify', ctx)

    const events: StreamEvent[] = []
    for await (const event of generator) {
      events.push(event)
    }

    // Assert that the generator successfully runs through all events and finishes
    expect(events.length > 0).toBe(true)

    // Check that we got the expected tool usage and delta outputs
    const textDeltas = events.filter((e) => e.type === 'text_delta') as Extract<
      StreamEvent,
      { type: 'text_delta' }
    >[]
    const toolUses = events.filter((e) => e.type === 'tool_use') as Extract<
      StreamEvent,
      { type: 'tool_use' }
    >[]

    expect(textDeltas.some((d) => d.text.includes('buggy source file'))).toBe(true)
    expect(textDeltas.some((d) => d.text.includes('null pointer bug'))).toBe(true)

    expect(toolUses.some((t) => t.name === 'Read')).toBe(true)
    expect(toolUses.some((t) => t.name === 'Grep')).toBe(true)
    expect(toolUses.some((t) => t.name === 'Edit')).toBe(true)
    expect(toolUses.some((t) => t.name === 'Bash')).toBe(true)

    // Check that src/buggy.ts was actually updated in the file system
    const currentBuggyContent = await readFile(buggyPath, 'utf-8')
    expect(currentBuggyContent).toContain("return 'Hello, Guest!'")
    expect(currentBuggyContent).not.toContain('Bypassing compiler checks')
  })
})
