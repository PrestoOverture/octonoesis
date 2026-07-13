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
