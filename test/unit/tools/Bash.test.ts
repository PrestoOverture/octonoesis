import { describe, expect, it } from 'bun:test'
import { getRepoRoot } from '../../../src/query'
import { bashTool } from '../../../src/tools/Bash'

describe('Bash tool', () => {
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }

  it('runs a simple command successfully', async () => {
    const result = await bashTool.call({ command: 'echo "hello agent"' }, ctx)
    console.log(result)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const output = JSON.parse(result.value)
      expect(output.code).toBe(0)
      expect(output.stdout.trim()).toBe('hello agent')
      expect(output.stderr).toBe('')
    }
  })

  it('blocks dangerous commands in the denylist', async () => {
    const result = await bashTool.call({ command: 'sudo apt install something' }, ctx)
    console.log(result)
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
