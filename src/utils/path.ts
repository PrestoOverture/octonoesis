import { spawnSync } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { resolve, sep } from 'node:path'

export type PathGuardResult =
  | { ok: true; resolvedPath: string; realPath: string }
  | { ok: false; error: string }

export async function assertInsideRepo(
  inputPath: string,
  repoRoot: string,
): Promise<PathGuardResult> {
  const resolvedPath = resolve(repoRoot, inputPath)

  if (!resolvedPath.startsWith(repoRoot + sep) && resolvedPath !== repoRoot) {
    return { ok: false, error: 'path_outside_repo: Resolved path escapes the repository root.' }
  }

  let realPath: string
  try {
    realPath = await realpath(resolvedPath)
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return { ok: false, error: `file_not_found: File "${inputPath}" does not exist.` }
    }
    return { ok: false, error: `path_error: ${(err as Error).message}` }
  }

  if (!realPath.startsWith(repoRoot + sep) && realPath !== repoRoot) {
    return {
      ok: false,
      error: 'path_outside_repo: Symlink target resolves outside the repository root.',
    }
  }

  return { ok: true, resolvedPath, realPath }
}

let cachedRepoRoot: string | null = null

/**
 * Discovers and caches the Git repository root using `git rev-parse --show-toplevel`.
 * Falls back to process.cwd() if not inside a git repository.
 *
 * @returns The absolute path to the repository root.
 */
export function getRepoRoot(): string {
  if (process.env.OCTONOESIS_REPO_ROOT) {
    return process.env.OCTONOESIS_REPO_ROOT
  }
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
 * @returns The resolved memory directory path.
 */
export function getMemoryDir(): string {
  if (process.env.OCTONOESIS_MEMORY_DIR) {
    return process.env.OCTONOESIS_MEMORY_DIR
  }
  return path.join(getRepoRoot(), '.octonoesis')
}
