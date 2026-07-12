import { beforeEach, describe, expect, it } from 'bun:test'
import { parseConfig } from '../../../src/config/schema'
import {
  clearAllowlist,
  registerPromptHandler,
  requestPermission,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm'

beforeEach(() => {
  clearAllowlist()
  unregisterPromptHandler()
})

describe('MCP qualified permission patterns', () => {
  it('applies exact deny and trusted allow patterns to namespaced tools', async () => {
    let prompts = 0
    registerPromptHandler(async () => {
      prompts++
      return 'allow_once'
    })
    const toolName = 'mcp__fixture__echo'

    const denied = parseConfig({ permissions: { denyPatterns: [toolName] } })
    expect(
      await requestPermission(toolName, { text: 'no' }, { repoRoot: '/tmp', config: denied }),
    ).toBe('deny')

    const allowed = parseConfig({ permissions: { allowPatterns: [toolName] } })
    expect(
      await requestPermission(toolName, { text: 'yes' }, { repoRoot: '/tmp', config: allowed }),
    ).toBe('allow_always')
    expect(prompts).toBe(0)
  })
})
