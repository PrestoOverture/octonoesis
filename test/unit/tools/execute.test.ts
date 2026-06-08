import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { getRepoRoot } from '../../../src/query'
import { readTool } from '../../../src/tools/Read'
import { runTool } from '../../../src/tools/execute'
import { clearRegistry, registerTool } from '../../../src/tools/registry'

// Mock the permissions hook module dynamically
mock.module('../../../src/permissions/hooks', () => {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: mock input
    preToolUseHook: async (toolName: string, input: any) => {
      if (toolName === 'Read' && input.path === 'blocked-by-hook.txt') {
        return { action: 'deny', reason: 'Blocked by mock hook' }
      }
      return { action: 'allow' }
    },
  }
})

describe('execute pipeline (runTool)', () => {
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }

  it('rejects an unregistered tool with unknown_tool error', async () => {
    clearRegistry()
    const result = await runTool('UnregisteredTool', {}, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('unknown_tool')
    }
  })

  it('validates schema and rejects bad input shape', async () => {
    clearRegistry()
    registerTool(readTool)

    // Read tool expects path (string), but we pass a number
    const result = await runTool('Read', { path: 12345 }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('invalid_input')
      expect(result.error).toContain('path')
    }
  })

  it('rejects execution if preToolUseHook returns deny', async () => {
    clearRegistry()
    registerTool(readTool)

    // The mock hook is programmed to deny Read on "blocked-by-hook.txt"
    const result = await runTool('Read', { path: 'blocked-by-hook.txt' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('permission_denied')
      expect(result.error).toContain('Blocked by mock hook')
    }
  })

  it('executes a valid registered tool successfully', async () => {
    clearRegistry()
    registerTool(readTool)

    const result = await runTool('Read', { path: 'package.json' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toContain('"name": "octonoesis"')
    }
  })

  describe('with non-read-only tools and permissions', () => {
    // Import helper modules dynamically or from local imports
    const { z } = require('zod')
    const {
      registerPromptHandler,
      unregisterPromptHandler,
      clearAllowlist,
    } = require('../../../src/permissions/confirm')

    const mockWriteTool = {
      name: 'MockWrite',
      description: 'A mock write tool',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      call: async () => ({ ok: true as const, value: 'wrote successfully' }),
    }

    beforeEach(() => {
      clearAllowlist()
      unregisterPromptHandler()
    })

    it('bypasses permission prompt for read-only tools', async () => {
      clearRegistry()
      registerTool(readTool)

      let promptCalled = false
      registerPromptHandler(async () => {
        promptCalled = true
        return 'allow_once'
      })

      const result = await runTool('Read', { path: 'package.json' }, ctx)
      expect(result.ok).toBe(true)
      expect(promptCalled).toBe(false)
    })

    it('rejects execution for non-read-only tool when user denies permission', async () => {
      clearRegistry()
      registerTool(mockWriteTool)

      let promptCalled = false
      registerPromptHandler(async () => {
        promptCalled = true
        return 'deny'
      })

      const result = await runTool('MockWrite', { path: 'test.txt', content: 'hello' }, ctx)
      expect(result.ok).toBe(false)
      expect(promptCalled).toBe(true)
      if (!result.ok) {
        expect(result.error).toContain('permission_denied')
        expect(result.error).toContain('User denied execution.')
      }
    })

    it('executes non-read-only tool when user approves permission', async () => {
      clearRegistry()
      registerTool(mockWriteTool)

      let promptCalled = false
      registerPromptHandler(async () => {
        promptCalled = true
        return 'allow_once'
      })

      const result = await runTool('MockWrite', { path: 'test.txt', content: 'hello' }, ctx)
      expect(result.ok).toBe(true)
      expect(promptCalled).toBe(true)
      if (result.ok) {
        expect(result.value).toBe('wrote successfully')
      }
    })
  })
})
