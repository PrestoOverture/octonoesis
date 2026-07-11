import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { setProvider } from '../../../src/providers'
import type { LLMProvider, StreamEvent } from '../../../src/providers/types'
import type { SessionState } from '../../../src/query/types'
import { App } from '../../../src/ui/App'

const originalEnv = {
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  model: process.env.MODEL,
  disableCompact: process.env.OCTONOESIS_DISABLE_COMPACT,
  disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
}
let memoryDir = ''

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

describe('App session observability', () => {
  beforeEach(async () => {
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-ui-session-'))
    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    process.env.MODEL = 'claude-haiku-4-5-ui'
    process.env.OCTONOESIS_DISABLE_COMPACT = '1'
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(): AsyncIterable<StreamEvent> {
        yield { type: 'text_delta', text: 'UI observable.' }
        yield { type: 'message_end', usage: { input_tokens: 1_000, output_tokens: 100 } }
      },
    }
    setProvider(provider)
  })

  afterEach(async () => {
    setProvider(null)
    await fs.rm(memoryDir, { recursive: true, force: true })
    for (const [key, value] of Object.entries({
      OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
      MODEL: originalEnv.model,
      OCTONOESIS_DISABLE_COMPACT: originalEnv.disableCompact,
      OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
    })) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  })

  it('uses session_state events as the StatusBar data source', async () => {
    const snapshots: Array<{ sessionState: SessionState; priced: boolean }> = []
    const view = render(
      <App onSessionState={(sessionState, priced) => snapshots.push({ sessionState, priced })} />,
    )
    try {
      view.stdin.write('show observability')
      await new Promise((resolve) => setTimeout(resolve, 20))
      view.stdin.write('\r')
      const frame = await waitForFrame(view.lastFrame, 'cost: $0.0012')

      expect(frame).toContain('in: 1.0k')
      expect(frame).toContain('out: 100')
      expect(frame).toContain('ctx: 1%')
      expect(snapshots.at(-1)?.sessionState.usage).toEqual({
        input_tokens: 1_000,
        output_tokens: 100,
      })
      expect(snapshots.at(-1)?.priced).toBe(true)
    } finally {
      view.unmount()
    }
  })
})
