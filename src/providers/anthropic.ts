import Anthropic from '@anthropic-ai/sdk'
import { dbg } from '../utils/debug'
import { getAnthropicKey } from '../utils/env'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

export type TextDelta = {
  type: 'text_delta'
  text: string
}

/**
 * Streams text deltas from Anthropic Messages API
 * @param userMessage the user's input
 */
export async function* callAnthropicStream(
  userMessage: string,
): AsyncGenerator<TextDelta, void, undefined> {
  const client = new Anthropic({ apiKey: getAnthropicKey() })
  const stream = client.messages.stream({
    model: DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [{ type: 'text', text: userMessage }] }],
  })

  dbg('api', 'streaming request', { model: DEFAULT_ANTHROPIC_MODEL })

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'text_delta', text: event.delta.text }
      dbg('stream', 'text_delta', { length: event.delta.text.length })
    }
  }
}
