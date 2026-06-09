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
export function TodoPanel() {
  const todos = useTodos()

  // Hide the panel entirely if there are no todos to keep the interface clean
  if (todos.length === 0) {
    return null
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      minWidth={25}
      marginLeft={2}
    >
      <Box marginBottom={1}>
        <Text bold color="magenta">
          Tasks
        </Text>
      </Box>
      {todos.map((todo) => {
        const isCompleted = todo.status === 'completed'
        return (
          <Box key={todo.id} flexDirection="row">
            <Text color={isCompleted ? 'green' : 'yellow'}>
              {isCompleted ? '  [✓] ' : '  [ ] '}
            </Text>
            <Text strikethrough={isCompleted} color={isCompleted ? 'gray' : 'white'}>
              {todo.content}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
