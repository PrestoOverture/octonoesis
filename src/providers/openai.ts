import OpenAI from 'openai'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { dbg } from '../utils/debug'
import { getOpenAIKey } from '../utils/env'
import { withRetryGenerator } from '../utils/retry'
import type { CanonicalMessage, CanonicalTool, LLMProvider, StreamEvent } from './types'

export const DEFAULT_OPENAI_MODEL = 'gpt-5-nano'

/**
 * Translates CanonicalMessages into OpenAI ChatCompletionMessageParam structures.
 * @param messages The canonical messages to translate.
 * @returns The translated OpenAI MessageParam array.
 */
export function toOpenAIMessages(messages: CanonicalMessage[]): ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    if (msg.role === 'user') {
      const contentStr =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
      return { role: 'user', content: contentStr }
    }
    if (msg.role === 'assistant') {
      const textBlock = msg.content.find((c) => c.type === 'text')
      const text = textBlock && 'text' in textBlock ? textBlock.text : undefined
      const toolUseBlocks = msg.content.filter((c) => c.type === 'tool_use')
      const tool_calls =
        toolUseBlocks.length > 0
          ? toolUseBlocks.map((block) => ({
            id: block.id,
            type: 'function' as const,
            function: {
              name: block.name,
              arguments:
                typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
            },
          }))
          : undefined
      return {
        role: 'assistant',
        content: text || null,
        tool_calls,
      }
    }
    // msg.role === 'tool'
    const contentStr =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
    return {
      role: 'tool',
      tool_call_id: msg.tool_use_id,
      content: contentStr,
    }
  })
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai-compatible' as const

  /**
   * Creates an abortable async stream of canonical events for OpenAI.
   * Maps message payloads, manages tool invocation chunk accumulation, and yields unified events.
   *
   * @param messages The normalized message history.
   * @param tools The active schemas of tools.
   * @param opts Configuration options for model, tokens limit, and abort signal.
   * @returns An async iterable yielding canonical StreamEvents.
   */
  async *createMessageStream(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    opts: {
      model: string
      maxTokens: number
      signal: AbortSignal
      system?: string
      dynamicSystem?: string
    },
  ): AsyncIterable<StreamEvent> {
    const apiKey = getOpenAIKey()
    const baseURL = process.env.OPENAI_BASE_URL || undefined
    const client = new OpenAI({ apiKey, baseURL })

    const openAIMessages = toOpenAIMessages(messages)
    const openAITools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

    // Prepend system message if system or dynamicSystem is provided
    if (opts.system || opts.dynamicSystem) {
      const parts = [opts.system, opts.dynamicSystem].filter(Boolean)
      const combined = parts.join('\n\n')
      if (combined) {
        openAIMessages.unshift({ role: 'system', content: combined })
      }
    }

    dbg('api', 'OpenAI streaming request', {
      model: opts.model,
      messageCount: openAIMessages.length,
    })

    const makeStream = async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      const stream = await client.chat.completions.create(
        {
          model: opts.model,
          max_completion_tokens: opts.maxTokens,
          messages: openAIMessages,
          tools: openAITools.length > 0 ? openAITools : undefined,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: opts.signal },
      )

      // Keep track of streaming tool call parts
      interface AccumulatedToolCall {
        id?: string
        name?: string
        arguments: string
      }
      const accumulatedToolCalls: Map<number, AccumulatedToolCall> = new Map()
      let inputTokens = 0
      let outputTokens = 0

      for await (const chunk of stream) {
        // Intercept token usage from the final chunks
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || inputTokens
          outputTokens = chunk.usage.completion_tokens || outputTokens
        }

        const choice = chunk.choices[0]
        if (!choice) continue

        const delta = choice.delta

        // 1. Text streaming
        if (delta.content) {
          yield { type: 'text_delta', text: delta.content }
          dbg('stream', 'text_delta', { length: delta.content.length })
        }

        // 2. Tool calls streaming
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index
            if (!accumulatedToolCalls.has(index)) {
              accumulatedToolCalls.set(index, { arguments: '' })
            }
            const accum = accumulatedToolCalls.get(index)
            if (accum) {
              if (tc.id) {
                accum.id = tc.id
              }
              if (tc.function?.name) {
                accum.name = tc.function.name
              }
              if (tc.function?.arguments) {
                accum.arguments += tc.function.arguments
              }
            }
          }
        }
      } // <-- End of chunk streaming loop

      // Yield all accumulated tool calls upon stream termination
      for (const [_, accum] of accumulatedToolCalls) {
        if (accum.id && accum.name) {
          let parsedInput: unknown = {}
          try {
            parsedInput = JSON.parse(accum.arguments)
          } catch (e) {
            dbg('stream', 'Failed to parse OpenAI tool call arguments', accum.arguments)
            parsedInput = accum.arguments
          }
          yield {
            type: 'tool_use',
            id: accum.id,
            name: accum.name,
            input: parsedInput,
          }
        }
      }

      // Yield message end token counts
      yield {
        type: 'message_end',
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      }
    }

    yield* withRetryGenerator(makeStream, { signal: opts.signal })
  }
}
