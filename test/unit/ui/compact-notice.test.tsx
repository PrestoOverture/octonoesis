// biome-ignore lint/suspicious/noExplicitAny: Bun.main is writable in the test runtime.
declare const Bun: any

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { setProvider } from '../../../src/providers'
import type { LLMProvider, StreamEvent } from '../../../src/providers/types'
import { App } from '../../../src/ui/App'

class CompactingUiProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  private turn = 0

  async *createMessageStream(): AsyncIterable<StreamEvent> {
    this.turn++
    if (this.turn <= 3) {
      yield {
        type: 'tool_use',
        id: `ui-read-${this.turn}`,
        name: 'Read',
        input: { path: 'package.json' },
      }
      yield { type: 'message_end', usage: { input_tokens: 5_000, output_tokens: 10 } }
      return
    }
    yield { type: 'text_delta', text: 'UI session complete.' }
    yield { type: 'message_end', usage: { input_tokens: 100, output_tokens: 10 } }
  }
}

async function waitForFrame(
  lastFrame: () => string | undefined,
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const frame = lastFrame() ?? ''
    if (frame.includes(expected)) return frame
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return lastFrame() ?? ''
}

describe('compact notice in the TUI', () => {
  const cliPath = path.resolve('src/cli.tsx')
  const originalEnv = {
    memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
    threshold: process.env.OCTONOESIS_COMPACT_THRESHOLD,
    forkMock: process.env.OCTONOESIS_FORK_MOCK,
    forkDepth: process.env.OCTONOESIS_FORK_DEPTH,
    disable: process.env.OCTONOESIS_DISABLE_COMPACT,
    disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
  }
  let originalMain: string
  let memoryDir: string

  beforeEach(async () => {
    originalMain = Bun.main
    Bun.main = cliPath
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-compact-ui-'))
    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    process.env.OCTONOESIS_COMPACT_THRESHOLD = '1000'
    process.env.OCTONOESIS_FORK_MOCK = JSON.stringify({ text: 'TUI compact summary' })
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    Reflect.deleteProperty(process.env, 'OCTONOESIS_FORK_DEPTH')
    Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_COMPACT')
    setProvider(new CompactingUiProvider())
  })

  afterEach(async () => {
    setProvider(null)
    Bun.main = originalMain
    await fs.rm(memoryDir, { recursive: true, force: true })
    for (const [key, value] of Object.entries({
      OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
      OCTONOESIS_COMPACT_THRESHOLD: originalEnv.threshold,
      OCTONOESIS_FORK_MOCK: originalEnv.forkMock,
      OCTONOESIS_FORK_DEPTH: originalEnv.forkDepth,
      OCTONOESIS_DISABLE_COMPACT: originalEnv.disable,
      OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })

  it('renders the query compact event as an inline notice', async () => {
    const view = render(<App />)
    try {
      view.stdin.write('exercise compaction')
      await new Promise((resolve) => setTimeout(resolve, 30))
      view.stdin.write('\r')
      const frame = await waitForFrame(view.lastFrame, 'Context compacted:')

      expect(/✻ Context compacted: [\d,]+ → [\d,]+ tokens/.test(frame)).toBe(true)
    } finally {
      view.unmount()
    }
  })
})
