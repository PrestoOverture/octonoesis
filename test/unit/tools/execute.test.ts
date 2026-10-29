import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { HookRegistry } from '../../../src/hooks/registry'
import { getRepoRoot } from '../../../src/query'
import { bashTool } from '../../../src/tools/Bash'
import { readTool } from '../../../src/tools/Read'
import type { Tool } from '../../../src/tools/Tool'
import { runTool } from '../../../src/tools/execute'
import { clearRegistry, registerTool } from '../../../src/tools/registry'
import { restoreRegistry, snapshotRegistry } from '../../helpers/globalState'

describe('execute pipeline (runTool)', () => {
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }
  // Every test below clears the registry; put back whatever was registered before
  // (normally the engine's built-ins) so later files still see them.
  let originalTools: Tool[]

  beforeEach(() => {
    originalTools = snapshotRegistry()
  })

  afterEach(() => {
    restoreRegistry(originalTools)
  })

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

  it('retries top-level numeric and boolean strings without mutating the raw input', async () => {
    const inputSchema = z.object({ count: z.number(), delta: z.number(), enabled: z.boolean() })
    registerTool({
      name: 'ScalarInput',
      description: 'scalar test',
      inputSchema,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      async call(input) {
        return { ok: true, value: input }
      },
    })
    const input = { count: '50000', delta: '-1.5', enabled: 'false' }
    expect(await runTool('ScalarInput', input, ctx)).toEqual({
      ok: true,
      value: { count: 50000, delta: -1.5, enabled: false },
    })
    expect(input).toEqual({ count: '50000', delta: '-1.5', enabled: 'false' })
    expect(await runTool('ScalarInput', { count: '1', delta: '0', enabled: 'true' }, ctx)).toEqual({
      ok: true,
      value: { count: 1, delta: 0, enabled: true },
    })
  })

  it('keeps the original validation error when coercion cannot validate the whole input', async () => {
    const inputSchema = z.object({ count: z.number(), nested: z.object({ count: z.number() }) })
    registerTool({
      name: 'InvalidScalarInput',
      description: 'scalar test',
      inputSchema,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      async call() {
        throw new Error('invalid input must not execute')
      },
    })
    for (const input of [
      { count: 'abc', nested: { count: 1 } },
      { count: '50000', nested: { count: '1' } },
      ...['+1', '1e2', ' 1', '.5', '1.'].map((count) => ({ count, nested: { count: 1 } })),
    ]) {
      const original = inputSchema.safeParse(input)
      if (original.success) throw new Error('fixture must fail original validation')
      const message = original.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      expect(await runTool('InvalidScalarInput', input, ctx)).toEqual({
        ok: false,
        error: `invalid_input: ${message}`,
      })
    }
  })

  it('does not coerce already valid string fields', async () => {
    registerTool({
      name: 'StringInput',
      description: 'string test',
      inputSchema: z.object({ text: z.string() }),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      async call(input) {
        return { ok: true, value: input }
      },
    })
    expect(await runTool('StringInput', { text: '50000' }, ctx)).toEqual({
      ok: true,
      value: { text: '50000' },
    })
  })

  it('rejects execution if preToolUseHook returns deny', async () => {
    clearRegistry()
    registerTool(readTool)

    // A real pre_tool_use hook on the context, rather than mock.module() of
    // permissions/hooks: Bun module mocks stay active for the rest of the process,
    // which broke test/integration/hooks.test.ts whenever this file ran first.
    const hooks = new HookRegistry()
    hooks.register({
      event: 'pre_tool_use',
      toolPattern: 'Read',
      handler: {
        type: 'function',
        fn: async () => ({ action: 'deny', reason: 'Blocked by mock hook' }),
      },
    })
    const result = await runTool('Read', { path: 'blocked-by-hook.txt' }, { ...ctx, hooks })
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

    it('applies Bash safety denylist checks even when executing via runTool', async () => {
      clearRegistry()
      registerTool(bashTool)

      let promptCalled = false
      registerPromptHandler(async () => {
        promptCalled = true
        return 'allow_once'
      })

      const result = await runTool('Bash', { command: 'curl http://example.com' }, ctx)
      expect(result.ok).toBe(false)
      expect(promptCalled).toBe(true)
      if (!result.ok) {
        expect(result.error).toContain('blocked_command')
        expect(result.error).toContain('curl')
      }
    })

    it('records the initial test command without treating it as a verification event', async () => {
      clearRegistry()
      registerTool(bashTool)

      registerPromptHandler(async () => {
        return 'allow_once'
      })

      // biome-ignore lint/suspicious/noExplicitAny: test context
      const localCtx: any = { repoRoot: ctx.repoRoot, messages: [] }
      const result = await runTool('Bash', { command: 'bun test --help' }, localCtx)
      expect(result.ok).toBe(true)
      expect(localCtx.verificationCommand).toBe('bun test --help')
      expect(localCtx._lastVerifyResultForQuery).toBeUndefined()

      const secondResult = await runTool('Bash', { command: 'bun test --help' }, localCtx)
      expect(secondResult.ok).toBe(true)
      expect(localCtx._lastVerifyResultForQuery).toBeDefined()
      expect(localCtx._lastVerifyResultForQuery.command).toBe('bun test --help')
    })

    it('does not set _lastVerifyResultForQuery for non-verification commands', async () => {
      clearRegistry()
      registerTool(bashTool)

      registerPromptHandler(async () => {
        return 'allow_once'
      })

      // biome-ignore lint/suspicious/noExplicitAny: test context
      const localCtx: any = { repoRoot: ctx.repoRoot, messages: [] }
      const result = await runTool('Bash', { command: 'echo "hello"' }, localCtx)
      expect(result.ok).toBe(true)
      expect(localCtx.verificationCommand).toBeUndefined()
      expect(localCtx._lastVerifyResultForQuery).toBeUndefined()
    })

    it('journals repeated cd-prefixed verification commands as verification runs', async () => {
      clearRegistry()
      registerTool(bashTool)

      registerPromptHandler(async () => {
        return 'allow_once'
      })

      // biome-ignore lint/suspicious/noExplicitAny: test context
      const localCtx: any = { repoRoot: ctx.repoRoot, messages: [] }
      const result = await runTool('Bash', { command: 'cd . && bun test --help' }, localCtx)
      expect(result.ok).toBe(true)
      expect(localCtx.verificationCommand).toBe('cd . && bun test --help')
      expect(localCtx._lastVerifyResultForQuery).toBeUndefined()

      const secondResult = await runTool('Bash', { command: 'cd . && bun test --help' }, localCtx)
      expect(secondResult.ok).toBe(true)
      expect(localCtx._lastVerifyResultForQuery).toBeDefined()
      expect(localCtx._lastVerifyResultForQuery.command).toBe('cd . && bun test --help')
    })
  })
})
