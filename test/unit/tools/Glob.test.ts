import { describe, expect, it } from 'bun:test'
import { getRepoRoot } from '../../../src/query'
import { globTool } from '../../../src/tools/Glob'

describe('Glob tool', () => {
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }

  it('lists existing files with pattern', async () => {
    // Glob a committed fixture — docs/ is gitignored and absent on CI checkouts.
    const result = await globTool.call({ pattern: 'test/fixtures/buggy-repo/**/*.ts' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.length >= 2).toBe(true)
      expect(result.value).toContain('test/fixtures/buggy-repo/src/buggy.ts')
    }
  })

  it('excludes node_modules and .git by default', async () => {
    const result = await globTool.call({ pattern: '**/node_modules/**/*' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.length).toBe(0)
    }
  })

  it('truncates matches according to limit', async () => {
    const result = await globTool.call({ pattern: 'src/**/*.ts', limit: 1 }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.length).toBe(1)
    }
  })

  it('blocks traversal escapes outside of repoRoot via cwd', async () => {
    const result = await globTool.call({ pattern: '*', cwd: '../../../../etc' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('path_outside_repo')
    }
  })
})
