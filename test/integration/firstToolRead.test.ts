import { describe, expect, it, mock } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { runQuery } from '../../src/query'

// Mock the anthropic provider to simulate a multi-turn tool-use conversation
mock.module('../../src/providers/anthropic', () => {
  let callCount = 0
  return {
    DEFAULT_ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
    callAnthropicStream: async function* (messages: Anthropic.MessageParam[]) {
      callCount++
      if (callCount === 1) {
        // Return a tool call request
        yield { type: 'text_delta', text: 'Let me inspect the project info first.' }
        yield {
          type: 'message_done',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me inspect the project info first.' },
              {
                type: 'tool_use',
                id: 'toolu_test_123',
                name: 'Read',
                input: { path: 'package.json' },
              },
            ],
          },
        }
      } else if (callCount === 2) {
        // Validate that the second turn sent the tool results from package.json back to the LLM
        const lastMsg = messages[messages.length - 1]
        expect(lastMsg).toBeDefined()
        expect(lastMsg?.role).toBe('user')

        const content = lastMsg?.content
        if (Array.isArray(content) && content[0]?.type === 'tool_result') {
          expect(content[0].tool_use_id).toBe('toolu_test_123')
          expect(content[0].content).toContain('"name": "octonoesis"')
        } else {
          throw new Error('Expected tool result content block')
        }

        yield { type: 'text_delta', text: 'It is named octonoesis.' }
        yield {
          type: 'message_done',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'It is named octonoesis.' }],
          },
        }
      }
    },
  }
})

describe('Phase 2 - End-to-End tool_use Loop', () => {
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
