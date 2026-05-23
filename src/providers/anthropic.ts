import Anthropic from '@anthropic-ai/sdk'
import { dbg } from '../utils/debug'
import { getAnthropicKey } from '../utils/env'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

export type AnthropicStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'message_done'; message: Anthropic.Message }

/**
 * Streams text deltas from Anthropic Messages API supporting a multi-turn conversation
 * @param userMessage the user's input
 */
export async function* callAnthropicStream(
  messages: Anthropic.MessageParam[],
): AsyncGenerator<AnthropicStreamEvent, void, undefined> {
  const client = new Anthropic({ apiKey: getAnthropicKey() })

  dbg('api', 'streaming request', {
    model: DEFAULT_ANTHROPIC_MODEL,
    messageCount: messages.length,
  })

  const stream = client.messages.stream({
    model: DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages,
    tools: [
      {
        name: 'Read',
        description: 'Read the contents of a file from the filesystem.',
        input_schema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The absolute or relative path to the file to read.',
            },
          },
          required: ['path'],
        },
      },
    ],
  })

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'text_delta', text: event.delta.text }
      dbg('stream', 'text_delta', { length: event.delta.text.length })
    }
  }

  const finalMessage = await stream.finalMessage()
  yield { type: 'message_done', message: finalMessage }
}
