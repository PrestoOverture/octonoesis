import { Box, Text } from 'ink'
import React from 'react'
import { useTodos } from '../state/todos'

/**
 * TodoPanel is a terminal TUI sidebar component that renders the list of todos.
 * Completed tasks are displayed with a strikethrough, and the panel has a round magenta border.
 * If the todo list is empty, the panel is hidden (returns null).
 *
 * @returns The rendered Box component containing tasks, or null if there are no tasks.
 */
export function TodoPanel({ maxRows = Number.POSITIVE_INFINITY }: { maxRows?: number }) {
  const todos = useTodos()

  // Hide the panel entirely if there are no todos to keep the interface clean
  if (todos.length === 0 || maxRows < 5) {
    return null
  }

  const limit = Math.max(0, maxRows - 5)
  const visible = todos.slice(0, limit)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      width={28}
      flexShrink={0}
      marginLeft={2}
    >
      <Box marginBottom={1}>
        <Text bold color="magenta">
          Tasks
        </Text>
      </Box>
      {visible.map((todo) => {
        const isCompleted = todo.status === 'completed'
        return (
          <Box key={todo.id} flexDirection="row" height={1} flexShrink={0} overflow="hidden">
            <Text color={isCompleted ? 'green' : 'yellow'}>
              {isCompleted ? '  [✓] ' : '  [ ] '}
            </Text>
            <Text
              wrap="truncate-end"
              strikethrough={isCompleted}
              color={isCompleted ? 'gray' : 'white'}
            >
              {todo.content.replace(/\s+/g, ' ')}
            </Text>
          </Box>
        )
      })}
      {todos.length > visible.length ? (
        <Text dimColor>+{todos.length - visible.length} more</Text>
      ) : null}
    </Box>
  )
}
