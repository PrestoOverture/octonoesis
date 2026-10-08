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
      expect(frame).toContain('1.5k in')
      expect(frame).toContain('500 out')
      expect(frame).toBe('claude-haiku-4-5 · $0.0000 · ctx 0% · 1.5k in / 500 out')
    }
  })
})
