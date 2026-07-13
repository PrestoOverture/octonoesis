import { afterEach, describe, expect, it } from 'bun:test'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createAgentWorktree, removeAgentWorktree } from '../../../src/utils/worktree'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', root, ...args])).stdout.trim()
}

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-worktree-test-'))
  roots.push(root)
  await execFileAsync('git', ['init', '-q', root])
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'config', 'user.name', 'Test')
  await fs.writeFile(path.join(root, 'tracked.txt'), 'HEAD canary')
  await git(root, 'add', 'tracked.txt')
  await git(root, 'commit', '-qm', 'fixture')
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('agent worktrees', () => {
  it('prunes stale metadata, creates a detached realpath worktree, and removes it', async () => {
    const root = await makeRepo()
    const first = await createAgentWorktree(root, 'agent-stale-test')
    await fs.rm(first.path, { recursive: true, force: true })

    const worktree = await createAgentWorktree(root, 'agent-stale-test')
    expect(worktree.path).toBe(await fs.realpath(worktree.path))
    expect(await fs.readFile(path.join(worktree.path, 'tracked.txt'), 'utf8')).toBe('HEAD canary')
    await expect(git(worktree.path, 'symbolic-ref', '-q', 'HEAD')).rejects.toThrow()
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain(worktree.path)

    await removeAgentWorktree(worktree)
    await expect(fs.access(worktree.path)).rejects.toThrow()
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain(worktree.path)
  })

  it('reports a clear error for a non-git directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-not-git-'))
    roots.push(root)
    await expect(createAgentWorktree(root, 'agent-no-git')).rejects.toThrow(
      'Background agents require a git repository',
    )
  })
})
