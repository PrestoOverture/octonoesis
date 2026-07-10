import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { flushJournal } from '../../../src/memory/journal'
import type { ForkOptions } from '../../../src/providers/fork'
import type { CanonicalMessage, Usage } from '../../../src/providers/types'
import {
  CompactAbortError,
  CompactError,
  compact,
  createCompactSummaryMessage,
  selectKeepTail,
  shouldCompact,
} from '../../../src/query/compact'
import { contextTokensWithEstimation } from '../../../src/utils/tokens'

const originalThreshold = process.env.OCTONOESIS_COMPACT_THRESHOLD
const originalDisable = process.env.OCTONOESIS_DISABLE_COMPACT
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let memoryDir = ''

beforeEach(async () => {
  memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-compact-unit-'))
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
})

afterEach(async () => {
  await flushJournal()
  await fs.rm(memoryDir, { recursive: true, force: true })
  if (originalThreshold === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_COMPACT_THRESHOLD')
  } else {
    process.env.OCTONOESIS_COMPACT_THRESHOLD = originalThreshold
  }
  if (originalDisable === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
  } else {
    process.env.OCTONOESIS_DISABLE_COMPACT = originalDisable
  }
  if (originalMemoryDir === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  } else {
    process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  }
})

describe('context compaction', () => {
  it('keeps at least the last three messages and walks back over leading tool results', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'request' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'one', name: 'Read', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'two', name: 'Read', input: { path: 'b.ts' } },
        ],
      },
      { role: 'tool', tool_use_id: 'one', content: 'first result' },
      { role: 'tool', tool_use_id: 'two', content: 'second result' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent response' }] },
    ]

    expect(selectKeepTail(messages)).toBe(1)
    expect(selectKeepTail(messages.slice(0, 3))).toBe(0)
    expect(selectKeepTail([])).toBe(0)
  })

  it('compacts only above the strict threshold and honors the disable switch', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'request' },
      { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: [{ type: 'text', text: 'latest' }] },
    ]
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '10'

    expect(shouldCompact(messages, 'claude-sonnet-4-6', { tokens: 10, coveredCount: 4 })).toBe(
      false,
    )
    expect(shouldCompact(messages, 'claude-sonnet-4-6', { tokens: 11, coveredCount: 4 })).toBe(true)

    process.env.OCTONOESIS_DISABLE_COMPACT = '1'
    expect(shouldCompact(messages, 'claude-sonnet-4-6', { tokens: 11, coveredCount: 4 })).toBe(
      false,
    )

    process.env.OCTONOESIS_DISABLE_COMPACT = 'false'
    expect(shouldCompact(messages, 'claude-sonnet-4-6', { tokens: 11, coveredCount: 4 })).toBe(true)
  })

  it('summarizes only the old prefix and accepts a smaller tagged replacement', async () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: `Original request: ${'detail '.repeat(120)}` },
      {
        role: 'assistant',
        content: [{ type: 'text', text: `Work performed in src/a.ts: ${'result '.repeat(100)}` }],
      },
      { role: 'user', content: `Verified facts: ${'fact '.repeat(80)}` },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'recent-read', name: 'Read', input: { path: 'b.ts' } }],
      },
      { role: 'tool', tool_use_id: 'recent-read', content: 'recent tool result' },
      { role: 'assistant', content: [{ type: 'text', text: 'most recent response' }] },
    ]
    const originalMessages = structuredClone(messages)
    const summary = 'User requested the fix; src/a.ts was inspected and current checks pass.'
    const forkUsage: Usage = { input_tokens: 12, output_tokens: 3 }
    let captured: ForkOptions | undefined
    let observedUsage: Usage | undefined
    const controller = new AbortController()

    const result = await compact(messages, {
      systemPrompt: 'byte-identical parent system',
      signal: controller.signal,
      onForkUsage: (usage) => {
        observedUsage = usage
      },
      forkFn: async (opts) => {
        captured = opts
        return { text: summary, usage: forkUsage, turns: 1, exitReason: 'completed' }
      },
    })

    expect(messages).toEqual(originalMessages)
    expect(captured?.systemPrompt).toBe('byte-identical parent system')
    expect(captured?.forkPurpose).toBe('compact')
    expect(captured?.tools).toEqual([])
    expect(captured?.maxTurns).toBe(1)
    expect(captured?.signal).toBe(controller.signal)
    expect(captured && 'model' in captured).toBe(false)
    expect(captured?.messages.slice(0, -1)).toEqual(messages.slice(0, 3))

    const instruction = captured?.messages.at(-1)
    expect(instruction?.role).toBe('user')
    const instructionText = instruction?.role === 'user' ? instruction.content : ''
    expect(/user intent|requests/i.test(JSON.stringify(instructionText))).toBe(true)
    expect(/file paths/i.test(JSON.stringify(instructionText))).toBe(true)
    expect(/verified state/i.test(JSON.stringify(instructionText))).toBe(true)
    expect(/pending next steps/i.test(JSON.stringify(instructionText))).toBe(true)
    expect(/technical learnings/i.test(JSON.stringify(instructionText))).toBe(true)
    expect(/dense|no preamble/i.test(JSON.stringify(instructionText))).toBe(true)
    expect(/newer messages/i.test(JSON.stringify(instructionText))).toBe(true)
    expect(
      /exact.*(literal|identifier|canar)|verbatim/i.test(JSON.stringify(instructionText)),
    ).toBe(true)

    expect(observedUsage).toEqual(forkUsage)
    expect(result.summary).toBe(summary)
    expect(result.messagesKept).toEqual(messages.slice(3))
    expect(result.preCompactTokens).toBe(contextTokensWithEstimation(messages))
    expect(result.postCompactTokens).toBe(
      contextTokensWithEstimation([createCompactSummaryMessage(summary), ...messages.slice(3)]),
    )
    expect(result.postCompactTokens).toBeLessThan(result.preCompactTokens)

    await flushJournal()
    const journalLines = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(journalLines.length).toBe(1)
    expect(journalLines[0]?.kind).toBe('compact')
    expect(journalLines[0]?.schema_version).toBe(2)
    expect(journalLines[0]?.pre_tokens).toBe(result.preCompactTokens)
    expect(journalLines[0]?.post_tokens).toBe(result.postCompactTokens)
    expect(journalLines[0]?.summary_length).toBe(result.summary.length)
    expect(typeof journalLines[0]?.ts).toBe('string')
    expect(typeof journalLines[0]?.session_id).toBe('string')
  })

  it('rejects a non-completed fork without changing history or journaling compaction', async () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'old request '.repeat(80) },
      { role: 'assistant', content: [{ type: 'text', text: 'old response '.repeat(80) }] },
      { role: 'user', content: 'recent one' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent two' }] },
    ]
    const originalMessages = structuredClone(messages)
    let observedUsage: Usage | undefined

    await expect(
      compact(messages, {
        systemPrompt: 'system',
        onForkUsage: (usage) => {
          observedUsage = usage
        },
        forkFn: async () => ({
          text: 'partial',
          usage: { input_tokens: 7, output_tokens: 2 },
          turns: 1,
          exitReason: 'fatal_error',
        }),
      }),
    ).rejects.toThrow(CompactError)

    expect(observedUsage).toEqual({ input_tokens: 7, output_tokens: 2 })
    expect(messages).toEqual(originalMessages)
    await flushJournal()
    expect(await fs.readdir(memoryDir)).toEqual([])
  })

  it('rejects an empty summary', async () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'old request '.repeat(80) },
      { role: 'assistant', content: [{ type: 'text', text: 'old response '.repeat(80) }] },
      { role: 'user', content: 'recent one' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent two' }] },
    ]

    await expect(
      compact(messages, {
        systemPrompt: 'system',
        forkFn: async () => ({
          text: '   \n ',
          usage: { input_tokens: 7, output_tokens: 2 },
          turns: 1,
          exitReason: 'completed',
        }),
      }),
    ).rejects.toThrow(CompactError)

    await flushJournal()
    expect(await fs.readdir(memoryDir)).toEqual([])
  })

  it('rejects a replacement that would not reduce token usage', async () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: [{ type: 'text', text: 'recent response' }] },
      { role: 'user', content: 'recent follow-up' },
      { role: 'assistant', content: [{ type: 'text', text: 'latest response' }] },
    ]
    const originalMessages = structuredClone(messages)

    await expect(
      compact(messages, {
        systemPrompt: 'system',
        forkFn: async () => ({
          text: 'oversized summary '.repeat(100),
          usage: { input_tokens: 7, output_tokens: 500 },
          turns: 1,
          exitReason: 'completed',
        }),
      }),
    ).rejects.toThrow(CompactError)

    expect(messages).toEqual(originalMessages)
    await flushJournal()
    expect(await fs.readdir(memoryDir)).toEqual([])
  })

  it('propagates fork cancellation as a distinct abort path', async () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'old request '.repeat(40) },
      { role: 'assistant', content: [{ type: 'text', text: 'old response '.repeat(40) }] },
      { role: 'user', content: 'recent follow-up' },
      { role: 'assistant', content: [{ type: 'text', text: 'latest response' }] },
    ]

    await expect(
      compact(messages, {
        systemPrompt: 'system',
        forkFn: async () => ({
          text: '',
          usage: { input_tokens: 3, output_tokens: 0 },
          turns: 0,
          exitReason: 'user_cancel',
        }),
      }),
    ).rejects.toThrow(CompactAbortError)

    await flushJournal()
    expect(await fs.readdir(memoryDir)).toEqual([])
  })
})
