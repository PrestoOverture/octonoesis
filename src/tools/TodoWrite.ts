import z from 'zod'
import { setTodos } from '../state/todos'
import type { Tool, ToolContext, ToolResult } from './Tool'

// Input validation schema using Zod
const TodoWriteInputSchema = z.object({
  todos: z.array(
    z.object({
      id: z.string().min(1, 'id is required'),
      content: z.string().min(1, 'content is required'),
      status: z.enum(['open', 'completed']),
    }),
  ),
})

type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>

/**
 * TodoWriteTool accepts a list of todo tasks and overwrites the in-memory todo state.
 * Since it is used to track agent tasks internally, it is treated as read-only/implicitly allowed.
 */
class TodoWriteTool implements Tool<TodoWriteInput, string> {
  name = 'TodoWrite'
  description = 'Write or update the task checklist in-memory.'
  inputSchema = TodoWriteInputSchema

  /**
   * Indicates that the TodoWrite tool is safe to execute concurrently.
   *
   * @returns True, since todo updates are concurrency safe.
   */
  isConcurrencySafe(): boolean {
    return true
  }

  /**
   * Indicates that the TodoWrite tool is treated as read-only.
   * This allows the agent to update the task checklist without prompting the user.
   *
   * @returns True, to skip the permission confirmation prompt.
   */
  isReadOnly(): boolean {
    return true
  }

  /**
   * Updates the global in-memory todo list.
   *
   * @param input List of todo items containing content and status.
   * @param _ctx The tool execution context.
   * @returns A promise resolving to the success confirmation message or failure result.
   */
  async call(input: TodoWriteInput, _ctx: ToolContext): Promise<ToolResult<string>> {
    try {
      setTodos(input.todos)
      return { ok: true, value: 'Todos updated successfully.' }
    } catch (err) {
      return { ok: false, error: `todo_write_error: ${(err as Error).message}` }
    }
  }
}

export const todoWriteTool = new TodoWriteTool()
