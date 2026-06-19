import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { setProvider } from '../../src/providers'
import type { LLMProvider } from '../../src/providers/types'
import { runQuery } from '../../src/query'

describe('Phase 2 - End-to-End tool_use Loop', () => {
  let callCount = 0

  beforeAll(() => {
    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* (messages, tools, opts) {
        callCount++
        if (callCount === 1) {
          yield { type: 'text_delta', text: 'Let me inspect the project info first.' }
          yield {
            type: 'tool_use',
            id: 'toolu_test_123',
            name: 'Read',
            input: { path: 'package.json' },
          }
          yield {
            type: 'message_end',
            usage: { input_tokens: 10, output_tokens: 5 },
          }
        } else if (callCount === 2) {
          const lastMsg = messages[messages.length - 1]
          expect(lastMsg).toBeDefined()
          expect(lastMsg?.role).toBe('tool')
          const toolMsg = lastMsg as { tool_use_id: string; content: string }
          expect(toolMsg.tool_use_id).toBe('toolu_test_123')
          expect(toolMsg.content).toContain('"name": "octonoesis"')

          yield { type: 'text_delta', text: 'It is named octonoesis.' }
          yield {
            type: 'message_end',
            usage: { input_tokens: 20, output_tokens: 10 },
          }
        }
      },
    }
    setProvider(mockProvider)
  })

  afterAll(() => {
    setProvider(null)
  })

  it('successfully loops tool execution and returns the final response', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write
    process.stdout.write = (str: string | Uint8Array) => {
      writes.push(typeof str === 'string' ? str : new TextDecoder().decode(str))
      return true
    }

    try {
      await runQuery('What is the project name?')
    } finally {
      process.stdout.write = originalWrite
    }

    const output = writes.join('')
    expect(output).toContain('Let me inspect the project info first.')
    expect(output).toContain('[Tool Call] Read package.json...')
    expect(output).toContain('It is named octonoesis.')
  })
})
