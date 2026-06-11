import Anthropic from '@anthropic-ai/sdk'
import { getAllTools } from '../tools/registry'
import { dbg } from '../utils/debug'
import { getAnthropicKey } from '../utils/env'
import { withRetryGenerator } from '../utils/retry'
import { zodToJsonSchema } from '../utils/schema'
import type {
  CanonicalMessage,
  CanonicalTool,
  ContentBlock,
  LLMProvider,
  StreamEvent,
} from './types'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'

export type AnthropicStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'message_done'; message: Anthropic.Message }

/**
 * Normalizes CanonicalMessages to Anthropic MessageParams at call-time.
 * @param messages The canonical messages to convert.
 * @returns The converted Anthropic MessageParam array.
 */
export function toAnthropicMessages(messages: CanonicalMessage[]): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_use_id,
            content:
              typeof msg.content === 'string'
                ? msg.content
                : msg.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
          },
        ],
      } as Anthropic.MessageParam
    }
    return msg as Anthropic.MessageParam
  })
}

/**
 * Streams text deltas from Anthropic Messages API supporting a multi-turn conversation.
 * Dynamically queries the tool registry to supply active tools to the LLM.
 *
 * @param messages The user/assistant message payload history.
 * @param signal The abort signal for cancellation.
 * @returns An async generator yielding Anthropic stream events.
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

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const

  /**
   * Creates an abortable async stream of canonical events for Anthropic.
   * Resolves active tools, formats conversation history, and handles stream completion.
   *
   * @param messages The normalized message history.
   * @param tools The active schemas of tools.
   * @param opts Configuration options for model, tokens limit, and abort signal.
   * @returns An async iterable yielding canonical StreamEvents.
   */
  async *createMessageStream(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    opts: { model: string; maxTokens: number; signal: AbortSignal },
  ): AsyncIterable<StreamEvent> {
    const apiMessages = toAnthropicMessages(messages)

    for await (const event of callAnthropicStream(apiMessages, opts.signal)) {
      if (event.type === 'text_delta') {
        yield { type: 'text_delta', text: event.text }
      } else if (event.type === 'message_done') {
        const finalMsg = event.message

        // Yield tool uses first if present in the final message content
        const toolUses = finalMsg.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        )
        for (const toolUse of toolUses) {
          yield {
            type: 'tool_use',
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
          }
        }

        // Yield final message end event with token usage
        yield {
          type: 'message_end',
          usage: {
            input_tokens: finalMsg.usage?.input_tokens || 0,
            output_tokens: finalMsg.usage?.output_tokens || 0,
          },
        }
      }
    }
  }
}
