import { describe, expect, it } from 'bun:test'
import type { CanonicalMessage } from '../../../src/providers/types'
import { sanitizeAgentForkMessages } from '../../../src/tools/AgentTool'

function toolUse(id: string) {
  return { type: 'tool_use' as const, id, name: 'Read', input: { path: `${id}.txt` } }
}

describe('sanitizeAgentForkMessages', () => {
  it('removes a trailing dangling tool_use while preserving sibling content', () => {
    const messages: CanonicalMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'keep exactly' }, toolUse('dangling')],
      },
    ]

    expect(sanitizeAgentForkMessages(messages)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'keep exactly' }] },
    ])
  })

  it('keeps only executed siblings from a multi-tool assistant message', () => {
    const messages: CanonicalMessage[] = [
      { role: 'assistant', content: [toolUse('tu1'), toolUse('tu2'), toolUse('tu3')] },
      { role: 'tool', tool_use_id: 'tu1', content: 'executed' },
    ]

    expect(sanitizeAgentForkMessages(messages)).toEqual([
      { role: 'assistant', content: [toolUse('tu1')] },
      { role: 'tool', tool_use_id: 'tu1', content: 'executed' },
    ])
  })

  it('drops an assistant message when removing dangling tools empties it', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: [toolUse('dangling')] },
    ]

    expect(sanitizeAgentForkMessages(messages)).toEqual([{ role: 'user', content: 'before' }])
  })

  it('returns clean history deep-equal and does not mutate its input', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'working' }, toolUse('paired')],
      },
      { role: 'tool', tool_use_id: 'paired', content: 'result' },
    ]
    const before = structuredClone(messages)

    expect(sanitizeAgentForkMessages(messages)).toEqual(before)
    expect(messages).toEqual(before)
  })
})
