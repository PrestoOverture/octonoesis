import { spawnSync } from 'node:child_process'
import path from 'node:path'

let cachedRepoRoot: string | null = null

/**
 * Discovers and caches the Git repository root using `git rev-parse --show-toplevel`.
 * Falls back to process.cwd() if not inside a git repository.
 *
 * @returns The absolute path to the repository root.
 */
export function getRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot

  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
    })
    if (result.status === 0 && result.stdout) {
      cachedRepoRoot = result.stdout.trim()
      return cachedRepoRoot
    }
  } catch {}

  cachedRepoRoot = process.cwd()
  return cachedRepoRoot
}

/**
 * Returns the directory path where memory/persistent files should live.
 * Respects OCTONOESIS_MEMORY_DIR env override for testing isolation.
 */
export function getMemoryDir(): string {
  if (process.env.OCTONOESIS_MEMORY_DIR) {
    return process.env.OCTONOESIS_MEMORY_DIR
  }
  return path.join(getRepoRoot(), '.octonoesis')
}
