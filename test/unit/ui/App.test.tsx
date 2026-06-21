import { describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { App, type CanonicalMessage } from '../../../src/ui/App'

describe('App TUI component', () => {
  it('renders MessageList, StreamingResponse, and Input regions', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'hello agent' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello human' }] },
    ]

    const { lastFrame } = render(
      <App
        messages={messages}
        streamingText="thinking..."
        streamingToolUses={[{ name: 'Bash' }]}
      />,
    )

    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      // 1. Verify MessageList renders conversation history (separated to prevent ANSI-color interference)
      expect(frame).toContain('User ›')
      expect(frame).toContain('hello agent')
      expect(frame).toContain('Agent ›')
      expect(frame).toContain('hello human')

      // 2. Verify StreamingResponse renders progressive stream & tool state
      expect(frame).toContain('thinking...')
      expect(frame).toContain('⏳')
      expect(frame).toContain('Bash')
      expect(frame).toContain('(running)')

      // 3. Verify Input container prompts user
      expect(frame).toContain('🤖 ›')
    }
  })

  it('intercepts /stats command and displays calibration stats inline', async () => {
    const testDir = path.join(__dirname, '../../../test-app-stats-memory')
    process.env.OCTONOESIS_MEMORY_DIR = testDir
    await fs.mkdir(testDir, { recursive: true })

    const mockRecord = {
      session_id: 'sess-test-app',
      ts: new Date().toISOString(),
      bucket_key: 'bun-test|TypeError',
      model_id: 'gpt-5-nano',
      attempt_count: 5,
      first_attempt_success: true,
      user_modifications: 0,
      user_reverts: 0,
      resolved: true,
    }
    await fs.writeFile(
      path.join(testDir, 'calibration.jsonl'),
      `${JSON.stringify(mockRecord)}\n`,
      'utf8',
    )

    const { stdin, lastFrame } = render(<App />)
    // Simulate typing "/stats"
    stdin.write('/stats')
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Simulate pressing Enter (carriage return)
    stdin.write('\r')

    // Wait a brief moment for the async import and fs call to flush
    await new Promise((resolve) => setTimeout(resolve, 150))

    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      expect(frame).toContain('User ›')
      expect(frame).toContain('/stats')
      expect(frame).toContain('bun-test|TypeError')
      expect(frame).toContain('insufficient data') // because total attempts is 1 (< 3 attempts)
    }

    // Clean up
    await fs.rm(testDir, { recursive: true, force: true })
    process.env.OCTONOESIS_MEMORY_DIR = undefined
  })
})
