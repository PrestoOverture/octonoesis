// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the test runtime.
declare const Bun: any

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { getProvider, getResolvedModel, setProvider } from '../../src/providers'
import { AnthropicProvider } from '../../src/providers/anthropic'
import { OpenAIProvider, toOpenAIMessages } from '../../src/providers/openai'
import type { CanonicalMessage, CanonicalTool } from '../../src/providers/types'
import {
  captureProviderCredentials,
  getProviderCredentialEnvironment,
  setProviderCredentialsForTests,
} from '../../src/utils/env'

// Both providers talk to a local fake API instead of mock.module() stubs: a
// module mock in Bun replaces the module for every file that runs later in the
// same process. Each SDK reads its base URL from the environment
// (ANTHROPIC_BASE_URL, OPENAI_BASE_URL), so the real provider code runs end to
// end against this server.
let anthropicEvents: unknown[] = []
let lastAnthropicBody: unknown = null
let openAIChunks: unknown[] = []
let lastOpenAIBody: unknown = null

function sseResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

let server: { port: number; stop(closeActiveConnections?: boolean): void }

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request: Request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/v1/messages') {
        lastAnthropicBody = await request.json()
        return sseResponse(
          anthropicEvents
            .map((event) => {
              const type = (event as { type: string }).type
              return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`
            })
            .join(''),
        )
      }
      if (pathname === '/v1/chat/completions') {
        lastOpenAIBody = await request.json()
        return sseResponse(
          `${openAIChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        )
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  server.stop(true)
})

/** Anthropic stream for one assistant message; content blocks are streamed in full. */
function anthropicMessageEvents(
  blocks: Array<
    | { type: 'text'; deltas: string[] }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >,
  usage: { input_tokens: number; output_tokens: number },
): unknown[] {
  const events: unknown[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    },
  ]
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const text of block.deltas) {
        events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
      }
    } else {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      })
    }
    events.push({ type: 'content_block_stop', index })
  })
  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  })
  events.push({ type: 'message_stop' })
  return events
}

describe('LLM Providers & Router Integration', () => {
  const originalCredentials = getProviderCredentialEnvironment()
  const originalEnv = {
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    MODEL: process.env.MODEL,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  }

  beforeEach(() => {
    setProvider(null)
    process.env.OPENAI_API_KEY = 'mock-key'
    process.env.ANTHROPIC_API_KEY = 'mock-key'
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.port}/v1`
    captureProviderCredentials()
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = val
      }
    }
    setProviderCredentialsForTests(originalCredentials)
  })

  describe('Routing & Configuration', () => {
    it('resolves AnthropicProvider by default or when set', () => {
      Reflect.deleteProperty(process.env, 'LLM_PROVIDER')
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
      Reflect.deleteProperty(process.env, 'MODEL')
      Reflect.deleteProperty(process.env, 'ANTHROPIC_MODEL')
      Reflect.deleteProperty(process.env, 'OPENAI_MODEL')
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
    it('correctly maps the Anthropic message stream to canonical StreamEvents', async () => {
      anthropicEvents = anthropicMessageEvents(
        [
          { type: 'text', deltas: ['Hello', '!'] },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'package.json' } },
        ],
        { input_tokens: 100, output_tokens: 50 },
      )

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
      lastAnthropicBody = null
      anthropicEvents = anthropicMessageEvents([], { input_tokens: 0, output_tokens: 0 })

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
      const params = lastAnthropicBody as any
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
      openAIChunks = [
        // Chunk 1: Text delta
        {
          choices: [{ delta: { content: 'Reading file' } }],
        },
        // Chunk 2: Tool call starts (index 0, id, function name)
        {
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
        },
        // Chunk 3: Tool call arguments append
        {
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
        },
        // Chunk 4: Final usage chunk
        {
          usage: { prompt_tokens: 80, completion_tokens: 40 },
          choices: [],
        },
      ]

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
      lastOpenAIBody = null
      openAIChunks = [{ usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] }]

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
      const body = lastOpenAIBody as any
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
