import { useEffect, useState } from 'react'

export interface Todo {
  id: string
  content: string
  status: 'open' | 'completed'
}

let globalTodos: Todo[] = []
const listeners = new Set<() => void>()

/**
 * Retrieves the current in-memory todo list.
 *
 * @returns The array of current todo items.
 */
export function getTodos(): Todo[] {
  return globalTodos
}

/**
 * Replaces the current todo list and notifies all subscribers.
 */
export function setTodos(todos: Todo[]): void {
  globalTodos = todos
  for (const listener of listeners) {
    listener()
  }
}

/**
 * A custom hook to access the todo list reactive to updates.
 *
 * @returns The reactive array of todo items.
 */
export function useTodos(): Todo[] {
  const [todos, setTodoState] = useState<Todo[]>(globalTodos)

  useEffect(() => {
    const handleUpdate = () => setTodoState([...globalTodos])
    listeners.add(handleUpdate)
    return () => {
      listeners.delete(handleUpdate)
    }
  }, [])

  return todos
}

/**
 * Resets the in-memory todo state (useful for test isolation).
 */
export function clearTodos(): void {
  globalTodos = []
  listeners.clear()
}
