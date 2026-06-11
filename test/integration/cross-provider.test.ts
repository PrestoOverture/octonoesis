import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { getProvider, getResolvedModel, setProvider } from '../../src/providers'
import {
  AnthropicProvider,
  type AnthropicStreamEvent,
  toAnthropicMessages,
} from '../../src/providers/anthropic'
import { OpenAIProvider, toOpenAIMessages } from '../../src/providers/openai'
import type { CanonicalMessage, CanonicalTool } from '../../src/providers/types'

// Mock Anthropic's callAnthropicStream helper
let mockAnthropicEvents: AnthropicStreamEvent[] = []
let lastCallAnthropicStreamParams: {
  messages: unknown[]
  signal?: unknown
  system?: unknown
} | null = null

mock.module('../../src/providers/anthropic', () => {
  return {
    DEFAULT_ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
    toAnthropicMessages,
    callAnthropicStream: async function* (messages: unknown[], signal?: unknown, system?: unknown) {
      lastCallAnthropicStreamParams = { messages, signal, system }
      for (const event of mockAnthropicEvents) {
        yield event
      }
    },
  }
})

// Mock the entire 'openai' module using Bun's mock.module
let mockOpenAICallback: () => AsyncGenerator<unknown, void, undefined> = async function* () {}
let lastOpenAICreateBody: unknown = null

mock.module('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          // biome-ignore lint/suspicious/noExplicitAny: mock completions stream return type
          create: async (body: unknown, opts?: unknown): Promise<any> => {
            lastOpenAICreateBody = body
            return mockOpenAICallback()
          },
        },
      }
    },
  }
})

describe('LLM Providers & Router Integration', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    setProvider(null)
    process.env.OPENAI_API_KEY = 'mock-key'
    process.env.ANTHROPIC_API_KEY = 'mock-key'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('Routing & Configuration', () => {
    it('resolves AnthropicProvider by default or when set', () => {
      process.env.LLM_PROVIDER = undefined
      const provider = getProvider()
      expect(provider instanceof AnthropicProvider).toBe(true)
      expect(provider.name).toBe('anthropic')
    })

    it('resolves OpenAIProvider when LLM_PROVIDER=openai', () => {
      process.env.LLM_PROVIDER = 'openai'
      const provider = getProvider()
      expect(provider instanceof OpenAIProvider).toBe(true)
      expect(provider.name).toBe('openai-compatible')
    })

    it('throws on unsupported LLM_PROVIDER value', () => {
      process.env.LLM_PROVIDER = 'unknown-llm'
      expect(() => getProvider()).toThrow('Unsupported LLM_PROVIDER')
    })

    it('resolves models correctly following priority constraints', () => {
      // 1. Default fallback
      process.env.MODEL = undefined
      process.env.ANTHROPIC_MODEL = undefined
      process.env.OPENAI_MODEL = undefined
      process.env.LLM_PROVIDER = 'anthropic'
      expect(getResolvedModel()).toBe('claude-haiku-4-5-20251001')

      process.env.LLM_PROVIDER = 'openai'
      expect(getResolvedModel()).toBe('gpt-5-nano')

      // 2. Provider-specific override
      process.env.ANTHROPIC_MODEL = 'custom-anthropic'
      process.env.OPENAI_MODEL = 'custom-openai'
      process.env.LLM_PROVIDER = 'anthropic'
      expect(getResolvedModel()).toBe('custom-anthropic')

      process.env.LLM_PROVIDER = 'openai'
      expect(getResolvedModel()).toBe('custom-openai')

      // 3. Global MODEL override (highest priority)
      process.env.MODEL = 'highest-priority-model'
      expect(getResolvedModel()).toBe('highest-priority-model')
    })
  })

  describe('AnthropicProvider Message Stream Translation', () => {
    it('correctly maps callAnthropicStream events to canonical StreamEvents', async () => {
      const mockMsg = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [
          { type: 'text', text: 'Hello!' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Read',
            input: { path: 'package.json' },
          },
        ],
      } as unknown as Anthropic.Message

      mockAnthropicEvents = [
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: '!' },
        { type: 'message_done', message: mockMsg },
      ]

      const provider = new AnthropicProvider()
      const events: unknown[] = []
      const signal = new AbortController().signal

      for await (const event of provider.createMessageStream([], [], {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 100,
        signal,
      })) {
        events.push(event)
      }

      expect(events).toEqual([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: '!' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { path: 'package.json' },
        },
        {
          type: 'message_end',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      ])
    })
    it('passes static system prompt with cache_control and prepends dynamic suffix to the first user message', async () => {
      lastCallAnthropicStreamParams = null
      mockAnthropicEvents = [
        { type: 'message_done', message: { content: [] } as unknown as Anthropic.Message },
      ]

      const provider = new AnthropicProvider()
      const canonicalMessages: CanonicalMessage[] = [{ role: 'user', content: 'hello' }]

      const generator = provider.createMessageStream(canonicalMessages, [], {
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 100,
        signal: new AbortController().signal,
        system: 'STATIC_PROMPT',
        dynamicSystem: 'DYNAMIC_SUFFIX',
      })

      for await (const _ of generator) {
      }

      // biome-ignore lint/suspicious/noExplicitAny: bypass type checks for mock assertions
      const params = lastCallAnthropicStreamParams as any
      expect(params).not.toBe(null)
      if (params) {
        expect(params.system).toEqual([
          { type: 'text', text: 'STATIC_PROMPT', cache_control: { type: 'ephemeral' } },
        ])
        expect(params.messages[0]).toEqual({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'DYNAMIC_SUFFIX',
            },
            {
              type: 'text',
              text: 'hello',
              cache_control: { type: 'ephemeral' },
            },
          ],
        })
      }
    })
  })

  describe('OpenAIProvider Message Stream Translation & Chunk Accumulation', () => {
    it('accumulates streaming tool calls and yields canonical events', async () => {
      mockOpenAICallback = async function* () {
        // Chunk 1: Text delta
        yield {
          choices: [{ delta: { content: 'Reading file' } }],
        }
        // Chunk 2: Tool call starts (index 0, id, function name)
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'Read', arguments: '{"pa' },
                  },
                ],
              },
            },
          ],
        }
        // Chunk 3: Tool call arguments append
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: 'th":"docs/prd.md"}' },
                  },
                ],
              },
            },
          ],
        }
        // Chunk 4: Final usage chunk
        yield {
          usage: { prompt_tokens: 80, completion_tokens: 40 },
          choices: [],
        }
      }

      const provider = new OpenAIProvider()
      const events: unknown[] = []
      const signal = new AbortController().signal

      for await (const event of provider.createMessageStream([], [], {
        model: 'gpt-5-nano',
        maxTokens: 100,
        signal,
      })) {
        events.push(event)
      }

      expect(events).toEqual([
        { type: 'text_delta', text: 'Reading file' },
        {
          type: 'tool_use',
          id: 'call_abc',
          name: 'Read',
          input: { path: 'docs/prd.md' },
        },
        {
          type: 'message_end',
          usage: { input_tokens: 80, output_tokens: 40 },
        },
      ])
    })
    it('prepends combined system message if system or dynamicSystem is provided', async () => {
      lastOpenAICreateBody = null
      mockOpenAICallback = async function* () {
        yield { usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] }
      }

      const provider = new OpenAIProvider()
      const canonicalMessages: CanonicalMessage[] = [{ role: 'user', content: 'hello' }]

      const generator = provider.createMessageStream(canonicalMessages, [], {
        model: 'gpt-5-nano',
        maxTokens: 100,
        signal: new AbortController().signal,
        system: 'STATIC_PROMPT',
        dynamicSystem: 'DYNAMIC_SUFFIX',
      })

      for await (const _ of generator) {
      }

      // biome-ignore lint/suspicious/noExplicitAny: bypass type checks for mock assertions
      const body = lastOpenAICreateBody as any
      expect(body).not.toBe(null)
      if (body) {
        expect(body.messages[0]).toEqual({
          role: 'system',
          content: 'STATIC_PROMPT\n\nDYNAMIC_SUFFIX',
        })
        expect(body.messages[1]).toEqual({
          role: 'user',
          content: 'hello',
        })
      }
    })
  })

  describe('OpenAI Message Translation Helper', () => {
    it('correctly maps tool roles and assistant message payloads', () => {
      const canonicalMessages: CanonicalMessage[] = [
        { role: 'user', content: 'check package name' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me run glob' },
            {
              type: 'tool_use',
              id: 'use_1',
              name: 'Glob',
              input: { pattern: 'package.json' },
            },
          ],
        },
        { role: 'tool', tool_use_id: 'use_1', content: '["package.json"]' },
      ]

      const openAIMessages = toOpenAIMessages(canonicalMessages)

      expect(openAIMessages).toEqual([
        { role: 'user', content: 'check package name' },
        {
          role: 'assistant',
          content: 'Let me run glob',
          tool_calls: [
            {
              id: 'use_1',
              type: 'function',
              function: {
                name: 'Glob',
                arguments: '{"pattern":"package.json"}',
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'use_1', content: '["package.json"]' },
      ])
    })
  })
})
