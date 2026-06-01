import { describe, expect, it } from 'bun:test'
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
})
