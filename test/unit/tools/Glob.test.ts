import { describe, expect, it } from 'bun:test'
import { getRepoRoot } from '../../../src/query'
import { globTool } from '../../../src/tools/Glob'

describe('Glob tool', () => {
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }

  it('lists existing files with pattern', async () => {
    const result = await globTool.call({ pattern: 'docs/*.md' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.length >= 4).toBe(true)
      expect(result.value).toContain('docs/prd.md')
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
