import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { parseConfig } from '../../../src/config/schema'
import {
  clearAllowlist,
  configureOneShotPermissions,
  getPermissionKey,
  registerPromptHandler,
  requestPermission,
  setPermissionInputStreamForTests,
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

  for (const mode of ['ask', 'accept-edits', 'bypass'] as const) {
    test(`explicit deny patterns win in ${mode} mode`, async () => {
      let promptCount = 0
      registerPromptHandler(async () => {
        promptCount++
        return 'allow_once'
      })
      configureOneShotPermissions(mode)
      try {
        const ctx = {
          repoRoot: process.cwd(),
          config: parseConfig({ permissions: { denyPatterns: ['Bash(rm *)', 'Edit', 'Write'] } }),
        }
        expect(await requestPermission('Bash', { command: 'rm -rf x' }, ctx)).toBe('deny')
        expect(await requestPermission('Edit', { path: 'main.ts' }, ctx)).toBe('deny')
        expect(await requestPermission('Write', { path: 'main.ts' }, ctx)).toBe('deny')
        expect(promptCount).toBe(0)
      } finally {
        configureOneShotPermissions()
        unregisterPromptHandler()
      }
    })
  }

  test('the fallback overwrite prompt prints an old-to-new diff', async () => {
    const repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'write-permission-')))
    const input = new PassThrough()
    const capture = new PassThrough()
    let output = ''
    capture.on('data', (chunk) => {
      output += chunk.toString()
    })
    configureOneShotPermissions('ask', capture as unknown as NodeJS.WriteStream)
    try {
      await writeFile(join(repoRoot, 'main.ts'), 'old content\n')
      setPermissionInputStreamForTests(input)
      input.end('n\n')
      expect(
        await requestPermission(
          'Write',
          { path: 'main.ts', content: 'new content\n' },
          { repoRoot },
        ),
      ).toBe('deny')
      const printed = output
      expect(printed).toContain('Tool: Write')
      expect(printed).toContain('@@')
      expect(printed).toContain('-old content')
      expect(printed).toContain('+new content')
    } finally {
      configureOneShotPermissions()
      setPermissionInputStreamForTests()
      input.destroy()
      capture.destroy()
      await rm(repoRoot, { recursive: true, force: true })
    }
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
