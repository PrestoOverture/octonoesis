import Anthropic from '@anthropic-ai/sdk'
import { getAllTools } from '../tools/registry'
import { dbg } from '../utils/debug'
import { getAnthropicKey } from '../utils/env'
import { withRetryGenerator } from '../utils/retry'
import { zodToJsonSchema } from '../utils/schema'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

export type AnthropicStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'message_done'; message: Anthropic.Message }

/**
 * Streams text deltas from Anthropic Messages API supporting a multi-turn conversation.
 * Dynamically queries the tool registry to supply active tools to the LLM.
 *
 * @param messages The user/assistant message payload history.
 * @param signal The abort signal for cancellation.
 */
export async function* callAnthropicStream(
  messages: Anthropic.MessageParam[],
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent, void, undefined> {
  const client = new Anthropic({ apiKey: getAnthropicKey() })

  dbg('api', 'streaming request', {
    model: DEFAULT_ANTHROPIC_MODEL,
    messageCount: messages.length,
  })

  // 1. Query registry and dynamically build tool schemas for Claude
  const activeTools = getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema),
  }))

  const makeStream = async function* (): AsyncGenerator<AnthropicStreamEvent, void, undefined> {
    // 2. Start messages stream
    const stream = client.messages.stream(
      {
        model: DEFAULT_ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages,
        tools: activeTools.length > 0 ? activeTools : undefined,
      },
      { signal },
    )

    // 3. Yield events
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text_delta', text: event.delta.text }
        dbg('stream', 'text_delta', { length: event.delta.text.length })
      }
    }

    const finalMessage = await stream.finalMessage()
    yield { type: 'message_done', message: finalMessage }
  }

  yield* withRetryGenerator(makeStream, { signal })
}
