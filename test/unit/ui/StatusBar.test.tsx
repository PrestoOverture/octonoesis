import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import { StatusBar } from '../../../src/ui/StatusBar'

describe('StatusBar Component', () => {
  it('renders active model name and formatted token counts correctly', () => {
    const { lastFrame } = render(
      <StatusBar modelName="claude-haiku-4-5" inputTokens={1500} outputTokens={500} />,
    )
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      expect(frame).toContain('claude-haiku-4-5')
      expect(frame).toContain('in: 1.5k')
      expect(frame).toContain('out: 500')
      expect(frame).toContain('total: 2.0k')
    }
  })
})
