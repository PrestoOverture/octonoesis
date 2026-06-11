import type { ToolContext } from '../query'
import { buildDynamicSuffix } from './dynamic'
import { buildStaticPrompt } from './static'

/**
 * Builds the static and dynamic system prompts for the current turn.
 * Coordinates static rules and active dynamic suffix values.
 */
export async function buildSystemMessages(
  ctx: ToolContext,
  modelName: string,
  usage: { input_tokens: number; output_tokens: number },
): Promise<{ system: string; dynamicSystem: string }> {
  const staticPrompt = buildStaticPrompt()
  const dynamicPrompt = await buildDynamicSuffix(ctx, modelName, usage)
  return {
    system: staticPrompt,
    dynamicSystem: dynamicPrompt,
  }
}
