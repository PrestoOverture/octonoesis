import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { DEFAULT_CONFIG } from '../../src/config/schema.ts'
import { setProvider } from '../../src/providers/index.ts'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent,
} from '../../src/providers/types.ts'
import { App } from '../../src/ui/App.tsx'
import { appendInputHistory, loadInputHistory } from '../../src/ui/inputHistory.ts'

const originalEnv = {
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
  disableCompact: process.env.OCTONOESIS_DISABLE_COMPACT,
}
let root = ''
let memoryDir = ''

class CapturingProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  readonly calls: CanonicalMessage[][] = []

  async *createMessageStream(
    messages: CanonicalMessage[],
    _tools: CanonicalTool[],
  ): AsyncIterable<StreamEvent> {
    this.calls.push(structuredClone(messages))
    yield { type: 'text_delta', text: 'done' }
    yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for TUI state')
}

function promptLine(frame: string | undefined): string {
  return (frame ?? '').split('\n').find((line) => line.includes('🤖 ›')) ?? ''
}

function userText(message: CanonicalMessage | undefined): string {
  if (!message || message.role !== 'user') return ''
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-daily-input-'))
  memoryDir = path.join(root, 'memory')
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
})

afterEach(async () => {
  setProvider(null)
  await fs.rm(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries({
    OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
    OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
    OCTONOESIS_DISABLE_COMPACT: originalEnv.disableCompact,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

function app(provider: CapturingProvider) {
  setProvider(provider)
  return render(
    <App
      ctx={{
        repoRoot: root,
        memoryDir,
        messages: [],
        tasks: new Map(),
        config: DEFAULT_CONFIG,
      }}
    />,
  )
}

describe('daily-driver TUI input', () => {
  it('recalls a prior submit and restores the in-progress draft', async () => {
    const provider = new CapturingProvider()
    const view = app(provider)
    view.stdin.write('yesterday prompt')
    await waitFor(() => promptLine(view.lastFrame()).includes('yesterday prompt'))
    view.stdin.write('\r')
    await waitFor(() => provider.calls.length === 1)
    await waitFor(() => promptLine(view.lastFrame()).includes('Type a message...'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await waitFor(async () => (await loadInputHistory(memoryDir)).length === 1)

    view.stdin.write('current draft')
    await waitFor(() => promptLine(view.lastFrame()).includes('current draft'))
    view.stdin.write('\x1b[A')
    await waitFor(() => promptLine(view.lastFrame()).includes('yesterday prompt'))
    expect(promptLine(view.lastFrame())).toContain('yesterday prompt')
    view.stdin.write('\x1b[B')
    await waitFor(() => promptLine(view.lastFrame()).includes('current draft'))
    expect(promptLine(view.lastFrame())).toContain('current draft')
    expect((await loadInputHistory(memoryDir)).map((entry) => entry.text)).toEqual([
      'yesterday prompt',
    ])
    view.unmount()
  })

  it('never replaces a multiline draft with history on Up', async () => {
    await appendInputHistory(memoryDir, 'must not replace')
    const provider = new CapturingProvider()
    const view = app(provider)
    await new Promise((resolve) => setTimeout(resolve, 30))
    view.stdin.write('line one\nline two')
    await waitFor(() => (view.lastFrame() ?? '').includes('line two'))
    view.stdin.write('\x1b[A')
    await new Promise((resolve) => setTimeout(resolve, 30))

    const frame = view.lastFrame() ?? ''
    expect(frame).toContain('line one')
    expect(frame).toContain('line two')
    expect(frame).not.toContain('must not replace')
    view.unmount()
  })

  it('submits one multiline canonical user message through continuation input', async () => {
    const provider = new CapturingProvider()
    const view = app(provider)
    view.stdin.write('first\\')
    await waitFor(() => promptLine(view.lastFrame()).includes('first'))
    view.stdin.write('\r')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(provider.calls.length).toBe(0)
    view.stdin.write('second')
    await waitFor(() => (view.lastFrame() ?? '').includes('second'))
    view.stdin.write('\r')
    await waitFor(() => provider.calls.length === 1)

    const sentUser = [...(provider.calls[0] ?? [])]
      .reverse()
      .find((message) => message.role === 'user')
    expect(userText(sentUser)).toBe('first\nsecond')
    view.unmount()
  })

  it('shows a resume banner without replaying the saved transcript', async () => {
    const provider = new CapturingProvider()
    setProvider(provider)
    const view = render(
      <App
        ctx={{
          repoRoot: root,
          memoryDir,
          messages: [
            { role: 'user', content: 'old transcript secret' },
            { role: 'assistant', content: [{ type: 'text', text: 'old assistant reply' }] },
          ],
          tasks: new Map(),
          config: DEFAULT_CONFIG,
        }}
        resumeInfo={{
          sessionId: '12345678-abcd',
          messageCount: 2,
          updatedAt: '2026-07-17T05:06:07.000Z',
        }}
      />,
    )

    const initial = view.lastFrame() ?? ''
    expect(initial).toContain('Resumed 12345678: 2 messages, last active 2026-07-17T05:06:07.000Z')
    expect(initial).not.toContain('old transcript secret')
    expect(initial).not.toContain('old assistant reply')

    view.stdin.write('new visible prompt')
    await waitFor(() => promptLine(view.lastFrame()).includes('new visible prompt'))
    view.stdin.write('\r')
    await waitFor(() => provider.calls.length === 1)
    await waitFor(() => promptLine(view.lastFrame()).includes('Type a message...'))
    const after = view.lastFrame() ?? ''
    expect(after).toContain('new visible prompt')
    expect(after).toContain('done')
    expect(after).not.toContain('old transcript secret')
    expect(after).not.toContain('old assistant reply')
    expect(
      provider.calls[0]?.some((message) => userText(message).includes('old transcript secret')),
    ).toBe(true)
    view.unmount()
  })
})
