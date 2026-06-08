import { describe, expect, it } from 'bun:test'
import { symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getRepoRoot } from '../../../src/query'
import { readTool } from '../../../src/tools/Read'

describe('Read tool', () => {
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }

  it('reads an existing file with line numbers', async () => {
    const result = await readTool.call({ path: 'package.json' }, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toContain('1\t{')
      expect(result.value).toContain('"name": "octonoesis"')
    }
  })

  it('rejects a nonexistent file with a structured error', async () => {
    const result = await readTool.call({ path: 'nonexistent-file-that-does-not-exist.txt' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('file_not_found')
    }
  })

  it('blocks directory traversal outside of repoRoot', async () => {
    const result = await readTool.call({ path: '../../../../etc/passwd' }, ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('path_outside_repo')
    }
  })

  it('blocks symlink escapes outside of repoRoot', async () => {
    // Create a symlink pointing to /etc/hosts inside the repoRoot
    const symlinkPath = join(repoRoot, 'test_hosts_symlink')
    try {
      await unlink(symlinkPath)
    } catch {}

    try {
      await symlink('/etc/hosts', symlinkPath)

      const result = await readTool.call({ path: 'test_hosts_symlink' }, ctx)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('path_outside_repo')
      }
    } finally {
      try {
        await unlink(symlinkPath)
      } catch {}
    }
  })

  it('records the file read state in the context', async () => {
    const checkCtx = { repoRoot }
    const result = await readTool.call({ path: 'package.json' }, checkCtx)
    expect(result.ok).toBe(true)

    const { checkFileState } = await import('../../../src/state/fileState')
    const { resolve } = await import('node:path')
    const status = await checkFileState(checkCtx, resolve(repoRoot, 'package.json'))
    expect(status).toBe('ok')
  })
})
