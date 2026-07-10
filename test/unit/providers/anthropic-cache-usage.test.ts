import { describe, expect, it } from 'bun:test'
import { toAnthropicMessages, toCanonicalUsage } from '../../../src/providers/anthropic'
import type { CanonicalMessage } from '../../../src/providers/types'

describe('Anthropic cached prompt usage', () => {
  it('preserves cache token counts when Anthropic reports them', () => {
    expect(
      toCanonicalUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      }),
    ).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    })
  })

  it('does not add optional keys when Anthropic omits cache usage', () => {
    expect(toCanonicalUsage({ input_tokens: 100, output_tokens: 50 })).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    })
  })
})

describe('Anthropic compacted history conversion', () => {
  it('does not mutate or grow adjacent summary and retained user messages', () => {
    const messages: CanonicalMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: '<octo-compact-summary>summary</octo-compact-summary>' }],
      },
      { role: 'user', content: [{ type: 'text', text: 'retained user tail' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'latest assistant' }] },
    ]
    const original = structuredClone(messages)

    const first = toAnthropicMessages(messages, true)
    const second = toAnthropicMessages(messages, true)

    expect(messages).toEqual(original)
    expect(second).toEqual(first)
    expect(JSON.stringify(first).match(/retained user tail/g)?.length).toBe(1)
  })
})
