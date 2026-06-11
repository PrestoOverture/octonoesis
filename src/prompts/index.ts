import type { ToolContext } from '../query'
import { buildDynamicSuffix } from './dynamic'
import { buildStaticPrompt } from './static'

/**
 * Builds the static and dynamic system prompts for the current turn.
 * Coordinates static rules and active dynamic suffix values.
 *
 * @param ctx The current tool execution context.
 * @param modelName The active LLM model name.
 * @param usage The cumulative input and output token count.
 * @return A promise resolving to the static and dynamic system prompt strings.
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
