import type { z } from 'zod'

/**
 * Context provided to tools during execution.
 * Holds query-level shared states such as the cached repository root path.
 */
export interface ToolContext {
  repoRoot: string
  abortSignal?: AbortSignal
}

/**
 * Standard return type internal to the tool executor.
 */
export type ToolResult<Output = unknown> =
  | { ok: true; value: Output }
  | { ok: false; error: string }

/**
 * Interface that all agent tools must implement.
 */
export interface Tool<Input = unknown, Output = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<Input>
  outputSchema?: z.ZodType<Output>

  /**
   * Tells the system if this tool can be run concurrently with other actions.
   * @param input
   */
  isConcurrencySafe(input: Input): boolean

  /**
   * Tells the system if this tool only performs read actions (skips security prompts).
   * @param input
   */
  isReadOnly(input: Input): boolean

  /**
   * Performs the tool execution.
   * @param input
   * @param ctx
   */
  call(input: Input, ctx: ToolContext): Promise<ToolResult<Output>>
}
