import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { setProvider } from '../../src/providers'
import type { LLMProvider } from '../../src/providers/types'
import { type CanonicalMessage, type ToolContext, query } from '../../src/query'

let mockBehavior: 'completed' | 'fatal_error' | 'max_turns' = 'completed'
let mockCalls = 0

// Installed through setProvider() rather than mock.module(): a module mock in
// Bun replaces the module for every file that runs later in the same process.
// The events are the canonical StreamEvents AnthropicProvider emits for each
// scripted response.
const provider: LLMProvider = {
  name: 'anthropic',
  async *createMessageStream() {
    mockCalls++
    if (mockBehavior === 'completed') {
      yield { type: 'text_delta', text: 'Hello human.' }
      yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } }
    } else if (mockBehavior === 'fatal_error') {
      throw new Error('LLM API Error')
    } else if (mockBehavior === 'max_turns') {
      yield {
        type: 'tool_use',
        id: `toolu_turn_${mockCalls}`,
        name: 'Read',
        input: { path: 'package.json' },
      }
      yield { type: 'message_end', usage: { input_tokens: 5, output_tokens: 5 } }
    }
  },
}

beforeEach(() => {
  setProvider(provider)
})

afterEach(() => {
  setProvider(null)
})

describe('query() API Generator', () => {
  it('covers the "completed" successful flow exit path', async () => {
    mockBehavior = 'completed'
    mockCalls = 0

    const ctx: ToolContext = { repoRoot: '.' }
    const generator = query('hello', ctx)

    const events = []
    for await (const event of generator) {
      events.push(event)
    }

    const finalGen = query('hello', ctx)
    let next = await finalGen.next()
    while (!next.done) {
      next = await finalGen.next()
    }
    const result = next.value

    expect(events.length).toBe(2)
    expect(events[0]).toEqual({ type: 'text_delta', text: 'Hello human.' })
    expect(events[1]).toEqual({
      type: 'message_end',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    expect(result).toBeDefined()
    expect(result?.exit_reason).toBe('completed')
    expect(result?.usage.input_tokens).toBe(10)
    expect(result?.turns).toBe(1)
  })

  it('covers the "fatal_error" API throw exit path', async () => {
    mockBehavior = 'fatal_error'
    mockCalls = 0

    const ctx: ToolContext = { repoRoot: '.' }
    const finalGen = query('hello', ctx)
    let next = await finalGen.next()
    while (!next.done) {
      next = await finalGen.next()
    }
    const result = next.value

    expect(result).toBeDefined()
    expect(result?.exit_reason).toBe('fatal_error')
    expect(result?.error).toBe('LLM API Error')
  })

  it('covers the "max_turns" boundary exit path', async () => {
    mockBehavior = 'max_turns'
    mockCalls = 0

    const ctx: ToolContext = { repoRoot: '.' }
    const finalGen = query('hello', ctx)
    let next = await finalGen.next()
    while (!next.done) {
      next = await finalGen.next()
    }
    const result = next.value

    expect(result).toBeDefined()
    expect(result?.exit_reason).toBe('max_turns')
    expect(result?.turns).toBe(50)
  })
})
