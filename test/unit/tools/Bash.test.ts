import { describe, expect, it } from 'bun:test'
import { registerPromptHandler, unregisterPromptHandler } from '../../../src/permissions/confirm'
import { getRepoRoot } from '../../../src/query'
import { bashTool } from '../../../src/tools/Bash'
import { runTool } from '../../../src/tools/execute'
import { registerTool } from '../../../src/tools/registry'

describe('Bash tool', () => {
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }

  it('runs a simple command successfully', async () => {
    const result = await bashTool.call({ command: 'echo "hello agent"' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const output = JSON.parse(result.value)
      expect(output.code).toBe(0)
      expect(output.stdout.trim()).toBe('hello agent')
      expect(output.stderr).toBe('')
    }
  })

  it('honors timeout_ms and names the actual timeout in its error', async () => {
    const started = performance.now()
    const result = await bashTool.call({ command: 'sleep 3', timeout_ms: 1000 }, ctx)
    expect(performance.now() - started).toBeLessThan(3000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('timeout:')
      expect(result.error).toContain('1000ms')
    }
  })

  it('honors explicit timeouts for a repeat verification command', async () => {
    registerTool(bashTool)
    registerPromptHandler(async () => 'allow_once')
    try {
      const result = await runTool(
        'Bash',
        { command: 'sleep 3', timeout_ms: 1000 },
        { ...ctx, verificationCommand: 'sleep 3' },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain('1000ms')
    } finally {
      unregisterPromptHandler()
    }
  })

  it('validates optional timeout_ms with a maximum of 600000', () => {
    expect(bashTool.inputSchema.safeParse({ command: 'true' }).success).toBe(true)
    expect(bashTool.inputSchema.safeParse({ command: 'true', timeout_ms: 600000 }).success).toBe(
      true,
    )
    for (const timeout_ms of [600001, 0, -1, 1.5]) {
      expect(bashTool.inputSchema.safeParse({ command: 'true', timeout_ms }).success).toBe(false)
    }
  })

  it('blocks dangerous commands in the denylist', async () => {
    const result = await bashTool.call({ command: 'sudo apt install something' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('blocked_command')
    }
  })

  it('handles aborted executions gracefully', async () => {
    const controller = new AbortController()
    const ctxWithAbort = { repoRoot, abortSignal: controller.signal }

    // Start a command that sleeps, but immediately abort it
    const promise = bashTool.call({ command: 'sleep 5' }, ctxWithAbort)
    controller.abort()

    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('aborted')
    }
  })
})
