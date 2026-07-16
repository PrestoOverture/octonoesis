import { beforeEach, describe, expect, test } from 'bun:test'
import {
  clearAllowlist,
  getPermissionKey,
  registerPromptHandler,
  requestPermission,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm'

describe('Permissions confirm', () => {
  beforeEach(() => {
    clearAllowlist()
    unregisterPromptHandler()
  })

  test('generates correct permission key', () => {
    const key = getPermissionKey('Bash', { command: 'bun test' })
    expect(key.startsWith('Bash:')).toBe(true)
    expect(key.length).toBe(13) // Bash (4) + : (1) + hash (8) = 13
  })

  test('delegates to prompt handler and caches allow_always', async () => {
    let callCount = 0
    registerPromptHandler(async () => {
      callCount++
      return 'allow_always'
    })

    const decision1 = await requestPermission('Bash', { command: 'bun test' })
    expect(decision1).toBe('allow_always')
    expect(callCount).toBe(1)

    // Second call with same parameters should hit the allowlist cache and not trigger prompt handler
    const decision2 = await requestPermission('Bash', { command: 'bun test' })
    expect(decision2).toBe('allow_always')
    expect(callCount).toBe(1) // Call count remains 1
  })

  test('does not cache allow_once', async () => {
    let callCount = 0
    registerPromptHandler(async () => {
      callCount++
      return 'allow_once'
    })

    const decision1 = await requestPermission('Bash', { command: 'bun test' })
    expect(decision1).toBe('allow_once')
    expect(callCount).toBe(1)

    const decision2 = await requestPermission('Bash', { command: 'bun test' })
    expect(decision2).toBe('allow_once')
    expect(callCount).toBe(2) // Prompt handler is called again
  })

  test('handles deny properly', async () => {
    registerPromptHandler(async () => {
      return 'deny'
    })

    const decision = await requestPermission('Bash', { command: 'bun test' })
    expect(decision).toBe('deny')
  })

  test('resolves a pending delegated prompt as deny when the query is aborted', async () => {
    const controller = new AbortController()
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    registerPromptHandler(async () => {
      notifyStarted?.()
      return new Promise(() => {})
    })

    const pending = requestPermission(
      'Bash',
      { command: 'bun test' },
      { repoRoot: process.cwd(), abortSignal: controller.signal },
    )
    await started
    controller.abort()
    const result = await Promise.race([
      pending,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])

    expect(result).toBe('deny')
  })
})
