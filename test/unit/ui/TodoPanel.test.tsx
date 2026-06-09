import { beforeEach, describe, expect, it } from 'bun:test'
import { render } from 'ink-testing-library'
import React from 'react'
import { clearTodos, setTodos } from '../../../src/state/todos'
import { TodoPanel } from '../../../src/ui/TodoPanel'

describe('TodoPanel Component', () => {
  beforeEach(() => {
    clearTodos()
  })

  it('renders nothing when there are no todos', () => {
    const { lastFrame } = render(<TodoPanel />)
    expect(lastFrame()).toBe('')
  })

  it('renders tasks with checkmark/space and content', () => {
    setTodos([
      { id: '1', content: 'Explore files', status: 'completed' },
      { id: '2', content: 'Run command', status: 'open' },
    ])

    const { lastFrame } = render(<TodoPanel />)
    const frame = lastFrame()
    expect(frame).toBeDefined()
    if (frame) {
      expect(frame).toContain('Tasks')
      expect(frame).toContain('[✓]')
      expect(frame).toContain('Explore files')
      expect(frame).toContain('[ ]')
      expect(frame).toContain('Run command')
    }
  })

  it('updates reactively when todos change', async () => {
    const { lastFrame } = render(<TodoPanel />)
    expect(lastFrame()).toBe('')

    // 1. Wait for hook mount & listener registration
    await new Promise((resolve) => setTimeout(resolve, 10))

    // 2. Update todo state
    setTodos([{ id: '1', content: 'Write tests', status: 'open' }])

    // 3. Wait for state trigger and component re-render
    await new Promise((resolve) => setTimeout(resolve, 10))

    const frame = lastFrame()
    expect(frame).toContain('Tasks')
    expect(frame).toContain('[ ]')
    expect(frame).toContain('Write tests')
  })
})
