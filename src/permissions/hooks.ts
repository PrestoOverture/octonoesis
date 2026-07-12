import { executeAttachedHooks } from '../hooks/execute'
import type { ToolContext } from '../tools/Tool'

export interface PreToolUseDecision {
  action: 'allow' | 'deny' | 'modify'
  reason?: string
  modifiedInput?: unknown
}

/**
 * Pre-execution hook that runs after validation but before human confirmation.
 * Currently stubbed to automatically approve all tool uses.
 *
 * @param toolName The name of the tool requesting execution.
 * @param input The validated input payload of the tool.
 * @param ctx The tool execution context.
 * @return A promise resolving to the execution decision.
 */
export async function preToolUseHook(
  toolName: string,
  input: unknown,
  ctx: ToolContext,
): Promise<PreToolUseDecision> {
  const result = await executeAttachedHooks(ctx, {
    event: 'pre_tool_use',
    tool: toolName,
    input,
    sessionId: ctx.sessionId,
  })
  if (result.denied) {
    return { action: 'deny', reason: result.reason ?? 'Blocked by pre_tool_use hook' }
  }
  return { action: 'allow' }
}
