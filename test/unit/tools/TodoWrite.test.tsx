import { beforeEach, describe, expect, it } from 'bun:test'
import { Text } from 'ink'
import { render } from 'ink-testing-library'
import React from 'react'
import { clearTodos, getTodos, useTodos } from '../../../src/state/todos'
import { todoWriteTool } from '../../../src/tools/TodoWrite'

describe('TodoWrite Tool & State', () => {
  const ctx = { repoRoot: '' }

  beforeEach(() => {
    clearTodos()
  })

  it('initially has empty todos', () => {
    expect(getTodos()).toEqual([])
  })

  it('updates in-memory state when tool is called', async () => {
    const result = await todoWriteTool.call(
      {
        todos: [
          { id: '1', content: 'Design implementation plan', status: 'completed' },
          { id: '2', content: 'Write code', status: 'open' },
        ],
      },
      ctx,
    )

    expect(result.ok).toBe(true)
    expect(getTodos()).toEqual([
      { id: '1', content: 'Design implementation plan', status: 'completed' },
      { id: '2', content: 'Write code', status: 'open' },
    ])
  })

  it('updates the useTodos hook reactively in Ink TUI components', async () => {
    const TestComponent = () => {
      const todos = useTodos()
      return <Text>{todos.map((t) => `${t.id}:${t.status}`).join(',')} </Text>
    }

    const { lastFrame } = render(<TestComponent />)

    // 1. Wait for React to run useEffect and register the listener
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Update todos via tool call
    await todoWriteTool.call(
      {
        todos: [{ id: '1', content: 'Test todo list', status: 'open' }],
      },
      ctx,
    )

    // 2. Wait for React to run state setter and re-render
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Assert the React component re-renders reactive to the update
    expect(lastFrame()?.trim()).toBe('1:open')
  })

  it('validates schema and rejects malformed inputs', async () => {
    // Missing status field
    const badInput = {
      todos: [{ id: '1', content: 'Bad todo' }],
    } as unknown as { todos: Array<{ id: string; content: string; status: 'open' | 'completed' }> }

    const parseResult = todoWriteTool.inputSchema.safeParse(badInput)
    expect(parseResult.success).toBe(false)
  })
})
