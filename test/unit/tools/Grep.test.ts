import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { getRepoRoot } from '../../../src/query'
import { grepTool } from '../../../src/tools/Grep'

// biome-ignore lint/suspicious/noExplicitAny: global environment type bypass
declare const Bun: any

describe('Grep tool', () => {
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }

  it('searches existing files with pattern', async () => {
    // Search a committed fixture — docs/ is gitignored and absent on CI checkouts.
    const result = await grepTool.call(
      { pattern: 'Intentionally buggy', path: 'test/fixtures/buggy-repo' },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toContain('test/fixtures/buggy-repo/src/buggy.ts')
      expect(result.value).toContain('Intentionally buggy')
    }
  })

  it('returns "No matches found." when pattern does not exist', async () => {
    const result = await grepTool.call(
      { pattern: 'nonexistent-pattern-xyz-123', path: 'test/fixtures/buggy-repo' },
      ctx,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe('No matches found.')
    }
  })

  it('blocks path escapes outside of repoRoot', async () => {
    const result = await grepTool.call({ pattern: 'test', path: '../../../../etc' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('path_outside_repo')
    }
  })

  it('handles nonexistent target paths gracefully', async () => {
    const result = await grepTool.call({ pattern: 'test', path: 'nonexistent-folder-abc' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('file_not_found')
    }
  })

  it('handles abort signals correctly', async () => {
    const abortController = new AbortController()
    const abortCtx = { repoRoot, abortSignal: abortController.signal }

    // Start grep and abort immediately
    const promise = grepTool.call({ pattern: 'test' }, abortCtx)
    abortController.abort()

    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('aborted')
    }
  })

  it('caps matches per file at 50', async () => {
    const originalSpawn = Bun.spawn
    try {
      // Create a mock spawn that returns 60 matches for a single file
      Bun.spawn = () => {
        const matches: string[] = []
        for (let i = 1; i <= 60; i++) {
          matches.push(
            JSON.stringify({
              type: 'match',
              data: {
                path: { text: resolve(repoRoot, 'mock-file.ts') },
                line_number: i,
                lines: { text: `match ${i}\n` },
              },
            }),
          )
        }
        const stdoutText = matches.join('\n')
        return {
          stdout: new Blob([stdoutText]).stream(),
          stderr: new Blob(['']).stream(),
          exited: Promise.resolve(0),
        }
      }

      const result = await grepTool.call({ pattern: 'match' }, ctx)
      expect(result.ok).toBe(true)
      if (result.ok) {
        const lines = result.value.split('\n')
        // Header "mock-file.ts:" + 50 matches + 1 trailing empty string
        expect(lines.length).toBe(51)
        expect(result.value).toContain('  50: match 50')
        expect(result.value).not.toContain('  51: match 51')
      }
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  it('truncates outputs exceeding 30000 characters', async () => {
    const originalSpawn = Bun.spawn
    try {
      Bun.spawn = () => {
        const matches: string[] = []
        // Produce total content length exceeding 30,000 characters
        for (let i = 1; i <= 10; i++) {
          const pathNum = `file-${i}.ts`
          for (let j = 1; j <= 50; j++) {
            matches.push(
              JSON.stringify({
                type: 'match',
                data: {
                  path: { text: resolve(repoRoot, pathNum) },
                  line_number: j,
                  lines: { text: `${'a'.repeat(100)}\n` },
                },
              }),
            )
          }
        }
        const stdoutText = matches.join('\n')
        return {
          stdout: new Blob([stdoutText]).stream(),
          stderr: new Blob(['']).stream(),
          exited: Promise.resolve(0),
        }
      }

      const result = await grepTool.call({ pattern: 'a' }, ctx)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.length <= 30000).toBe(true)
        expect(result.value).toContain('Output truncated to stay under 30000 character limit')
      }
    } finally {
      Bun.spawn = originalSpawn
    }
  })
})
