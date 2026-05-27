import type { ToolContext } from '../tools/Tool'

export interface PreToolUseDecision {
  action: 'allow' | 'deny' | 'modify'
  reason?: string
  modifiedInput?: unknown
}

/**
 * Pre-execution hook that runs after validation but before human confirmation.
 * Currently stubbed to automatically approve all tool uses.
 * @param toolName
 * @param input
 * @param ctx
 * @returns
 */
export async function preToolUseHook(
  toolName: string,
  input: unknown,
  ctx: ToolContext,
): Promise<PreToolUseDecision> {
  return { action: 'allow' }
}
