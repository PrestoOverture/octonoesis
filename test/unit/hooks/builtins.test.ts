import { describe, expect, test } from 'bun:test'
import { registerBuiltinHooks } from '../../../src/hooks/builtins'
import { HookRegistry } from '../../../src/hooks/registry'

describe('registerBuiltinHooks', () => {
  test('gives extraction 30 seconds while stats keeps the default timeout', () => {
    const registry = new HookRegistry()
    registerBuiltinHooks(registry)

    expect(registry.match('stop')[0]?.timeoutMs).toBe(30_000)
    expect(registry.match('session_end')[0]?.timeoutMs).toBeUndefined()
  })
})
