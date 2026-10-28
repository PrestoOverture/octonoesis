import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AnthropicProvider } from '../../../src/providers/anthropic'
import { OpenAIProvider } from '../../../src/providers/openai'
import type { LLMProvider, StopReason, StreamEvent } from '../../../src/providers/types'
import {
  getProviderCredentialEnvironment,
  setProviderCredentialsForTests,
} from '../../../src/utils/env'

const credentials = getProviderCredentialEnvironment()
let originalFetch: typeof fetch

beforeEach(() => {
  setProviderCredentialsForTests({
    ANTHROPIC_API_KEY: 'test-key',
    OPENAI_API_KEY: 'test-key',
    SPARK_API_KEY: 'test-key',
  })
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setProviderCredentialsForTests(credentials)
})

function respond(chunks: unknown[], anthropic = false): void {
  globalThis.fetch = async () =>
    new Response(
      chunks
        .map((chunk) =>
          anthropic
            ? `event: ${(chunk as { type: string }).type}\ndata: ${JSON.stringify(chunk)}\n\n`
            : `data: ${JSON.stringify(chunk)}\n\n`,
        )
        .join('') + (anthropic ? '' : 'data: [DONE]\n\n'),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
}

async function collect(provider: LLMProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of provider.createMessageStream([], [], {
    model: 'test-model',
    maxTokens: 123,
    signal: AbortSignal.timeout(5000),
  })) {
    events.push(event)
  }
  return events
}

describe('Anthropic stream stop reasons', () => {
  const cases: [string | null, StopReason][] = [
    ['end_turn', 'end_turn'],
    ['tool_use', 'tool_use'],
    ['max_tokens', 'max_tokens'],
    ['stop_sequence', 'other'],
    ['pause_turn', 'other'],
    [null, 'other'],
  ]
  for (const [reason, expected] of cases) {
    test(`${reason} maps to ${expected} from finalMessage`, async () => {
      respond(
        [
          {
            type: 'message_start',
            message: {
              id: 'msg-test',
              type: 'message',
              role: 'assistant',
              model: 'test-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: reason, stop_sequence: null },
            usage: { output_tokens: 12 },
          },
          { type: 'message_stop' },
        ],
        true,
      )
      expect(await collect(new AnthropicProvider())).toEqual([
        {
          type: 'message_end',
          stopReason: expected,
          usage: { input_tokens: 10, output_tokens: 12 },
        },
      ])
    })
  }
})

for (const mode of ['openai', 'spark'] as const) {
  describe(`${mode} stream stop reasons and arguments`, () => {
    const cases: [string | null, StopReason][] = [
      ['stop', 'end_turn'],
      ['tool_calls', 'tool_use'],
      ['length', 'max_tokens'],
      ['content_filter', 'other'],
      ['future_reason', 'other'],
      [null, 'other'],
    ]
    for (const [reason, expected] of cases) {
      test(`${reason} maps to ${expected} and survives a later usage-only chunk`, async () => {
        respond([
          { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: reason }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 12 } },
        ])
        expect(await collect(new OpenAIProvider(mode))).toEqual([
          { type: 'text_delta', text: 'partial' },
          {
            type: 'message_end',
            stopReason: expected,
            usage: { input_tokens: 10, output_tokens: 12 },
          },
        ])
      })
    }

    test('rejects malformed JSON without emitting raw tool input and preserves call order', async () => {
      respond([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: 'bad', function: { name: 'Write', arguments: '{"path":' } },
                  { index: 0, id: 'good', function: { name: 'Read', arguments: '{"path":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"x.ts"}' } }] },
              finish_reason: 'length',
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 123 } },
      ])
      expect(await collect(new OpenAIProvider(mode))).toEqual([
        { type: 'tool_use', id: 'good', name: 'Read', input: { path: 'x.ts' } },
        {
          type: 'message_end',
          stopReason: 'max_tokens',
          usage: { input_tokens: 10, output_tokens: 123 },
          invalidToolCalls: [{ id: 'bad', name: 'Write' }],
          lastToolUseId: 'bad',
        },
      ])
    })
  })
}
