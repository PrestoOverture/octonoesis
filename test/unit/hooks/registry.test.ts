import { describe, expect, test } from 'bun:test'
import { HookRegistry } from '../../../src/hooks/registry'
import type { HookEvent, HookMatcher } from '../../../src/hooks/types'

const events: HookEvent[] = [
  'pre_tool_use',
  'post_tool_use',
  'stop',
  'session_start',
  'session_end',
  'compact',
]

function matcher(event: HookEvent, toolPattern?: string): HookMatcher {
  return {
    event,
    ...(toolPattern ? { toolPattern } : {}),
    handler: { type: 'function', fn: async () => undefined },
  }
}

describe('HookRegistry', () => {
  test('registers and matches all six lifecycle events', () => {
    const registry = new HookRegistry()
    for (const event of events) registry.register(matcher(event))

    for (const event of events) expect(registry.match(event).length).toBe(1)
  })

  test('matches exact tool names and trailing-star prefix globs', () => {
    const registry = new HookRegistry()
    registry.register(matcher('pre_tool_use', 'Bash'))
    registry.register(matcher('pre_tool_use', 'mcp__github__*'))
    registry.register(matcher('pre_tool_use', '*'))

    expect(registry.match('pre_tool_use', 'Bash').length).toBe(2)
    expect(registry.match('pre_tool_use', 'Read').length).toBe(1)
    expect(registry.match('pre_tool_use', 'mcp__github__issue').length).toBe(2)
    expect(registry.match('post_tool_use', 'Bash')).toEqual([])
  })
})
