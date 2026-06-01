import { describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import { ToolCard } from '../../../src/ui/ToolCard'

describe('ToolCard Component', () => {
  it('renders correctly for status "running"', () => {
    const { lastFrame } = render(<ToolCard tool="Bash" args="bun test" status="running" />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      expect(frame).toContain('⏳')
      expect(frame).toContain('Bash')
      expect(frame).toContain('bun test')
      expect(frame).toContain('(running)')
    }
  })

  it('renders correctly for status "done"', () => {
    const { lastFrame } = render(<ToolCard tool="Read" args="package.json" status="done" />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      expect(frame).toContain('✅')
      expect(frame).toContain('Read')
      expect(frame).toContain('package.json')
      expect(frame).toContain('(done)')
    }
  })

  it('renders correctly for status "error"', () => {
    const { lastFrame } = render(<ToolCard tool="Glob" args="invalid/**" status="error" />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      expect(frame).toContain('❌')
      expect(frame).toContain('Glob')
      expect(frame).toContain('invalid/**')
      expect(frame).toContain('(error)')
    }
  })
})
