import { describe, expect, test } from 'bun:test'
import type { PreparedFork } from '../../../src/providers/fork'
import { runForkLoop } from '../../../src/providers/forkChild'
import type { CanonicalMessage, LLMProvider, StreamEvent } from '../../../src/providers/types'

describe('skill fork child loop', () => {
  test('executes a prepared read-only tool and returns the following turn', async () => {
    const seen: CanonicalMessage[][] = []
    let turn = 0
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(messages): AsyncIterable<StreamEvent> {
        seen.push(structuredClone(messages))
        if (turn++ === 0) {
          yield { type: 'tool_use', id: 'call-1', name: 'Glob', input: { pattern: 'package.json' } }
        } else {
          yield { type: 'text_delta', text: 'done' }
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    const prepared: PreparedFork = {
      repoRoot: process.cwd(),
      purpose: 'skill',
      systemPrompt: 'parent stable',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [{ name: 'Glob', description: 'glob', inputSchema: { type: 'object' } }],
      childEnv: { OCTONOESIS_FORK_DEPTH: '1' },
      budget: { maxTurns: 8 },
      model: 'test',
    }

    const result = await runForkLoop(prepared, provider, new AbortController().signal)
    expect(result.text).toBe('done')
    expect(result.turns).toBe(2)
    const last = seen[1]?.at(-1)
    expect(last?.role).toBe('tool')
    expect(last?.role === 'tool' ? last.tool_use_id : undefined).toBe('call-1')
  })

  test('refuses unprepared tools without executing them', async () => {
    let turn = 0
    let refusal = ''
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(messages): AsyncIterable<StreamEvent> {
        if (turn++ === 0) {
          yield { type: 'tool_use', id: 'bad', name: 'Read', input: { path: 'package.json' } }
        } else {
          const message = messages.at(-1)
          refusal =
            message?.role === 'tool'
              ? typeof message.content === 'string'
                ? message.content
                : message.content
                    .map((block) => (block.type === 'tool_result' ? block.content : ''))
                    .join('')
              : ''
          yield { type: 'text_delta', text: 'handled' }
        }
        yield { type: 'message_end', usage: { input_tokens: 0, output_tokens: 0 } }
      },
    }
    const prepared: PreparedFork = {
      repoRoot: process.cwd(),
      purpose: 'skill',
      systemPrompt: 'stable',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [],
      childEnv: {},
      budget: { maxTurns: 2 },
      model: 'test',
    }
    expect((await runForkLoop(prepared, provider, new AbortController().signal)).text).toBe(
      'handled',
    )
    expect(refusal).toContain('not available')
  })
})
