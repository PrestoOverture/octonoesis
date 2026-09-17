import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const WORKTREE_PARENT = path.join(os.tmpdir(), 'octonoesis-worktrees')

export interface AgentWorktree {
  repoRoot: string
  path: string
}

/**
 * Asserts that the given directory path is inside a working Git repository.
 * @param repoRoot Path to the repository root.
 * @throws {Error} If the path is not a git repository.
 */
async function assertGitRepository(repoRoot: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoRoot,
      'rev-parse',
      '--is-inside-work-tree',
    ])
    if (stdout.trim() !== 'true') throw new Error('not a git work tree')
  } catch (error) {
    throw new Error(`Background agents require a git repository: ${repoRoot}`, { cause: error })
  }
}

/**
 * Creates an isolated detached-HEAD git worktree for a background agent subtask under os.tmpdir().
 * Prunes dead worktrees and removes any pre-existing directory for agentId.
 * @param repoRoot Repository root path.
 * @param agentId Unique identifier for the background agent.
 * @returns An AgentWorktree object containing repoRoot and the realpath of the created worktree directory.
 * @throws {Error} If git repository verification fails or worktree creation fails.
 */
export async function createAgentWorktree(
  repoRoot: string,
  agentId: string,
): Promise<AgentWorktree> {
  await assertGitRepository(repoRoot)
  await fs.mkdir(WORKTREE_PARENT, { recursive: true })
  const target = path.join(WORKTREE_PARENT, agentId)
  await execFileAsync('git', ['-C', repoRoot, 'worktree', 'prune'])
  await fs.rm(target, { recursive: true, force: true })
  try {
    await execFileAsync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', target, 'HEAD'])
    return { repoRoot, path: await fs.realpath(target) }
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true })
    throw new Error(`Failed to create background-agent worktree: ${agentId}`, { cause: error })
  }
}

/**
 * Force-removes a background agent worktree via git worktree remove and deletes its filesystem directory.
 * @param worktree The AgentWorktree to remove.
 */
export async function removeAgentWorktree(worktree: AgentWorktree): Promise<void> {
  try {
    await execFileAsync('git', [
      '-C',
      worktree.repoRoot,
      'worktree',
      'remove',
      '--force',
      worktree.path,
    ])
  } finally {
    await fs.rm(worktree.path, { recursive: true, force: true })
  }
}
