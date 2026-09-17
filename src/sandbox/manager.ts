import { constants, accessSync, existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SandboxConfig } from '../query/types'
import { DEFAULT_ALLOW_WRITE, DEFAULT_DENY_READ, type ResolvedSandboxConfig } from './types'

export interface SandboxConfigEnvironment {
  homeDir?: string
  tmpDir?: string
}

export interface SandboxConfigSources {
  repoRoot: string
  cliEnabled?: boolean
  /** Parsed `.octonoesis/config.json` sandbox settings. */
  config?: SandboxConfig
  environment?: SandboxConfigEnvironment
}

export interface SandboxAvailabilityEnvironment {
  platform?: NodeJS.Platform
  findExecutable?: (name: string) => string | null
}

/**
 * Scans directories in PATH to locate an executable by filename.
 * @param name Executable filename to find.
 * @returns Absolute path to the executable, or null if not found or not executable.
 */
function findExecutable(name: string): string | null {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory || process.cwd(), name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

/**
 * Checks whether the platform and environment support sandbox execution (macOS darwin with sandbox-exec binary).
 * @param environment Optional platform and lookup function overrides.
 * @returns True if sandbox execution is available, false otherwise.
 */
export function isSandboxAvailable(environment: SandboxAvailabilityEnvironment = {}): boolean {
  const platform = environment.platform ?? process.platform
  const lookup = environment.findExecutable ?? findExecutable
  return platform === 'darwin' && lookup('sandbox-exec') !== null
}

/**
 * Asserts that macOS sandbox-exec is available before attempting sandboxed execution.
 * Refuses to fall back to unsandboxed execution if sandboxing was requested.
 * @param availabilityCheck Optional custom availability probe function.
 * @throws {Error} If sandbox is unavailable.
 */
export function assertSandboxAvailable(
  availabilityCheck: () => boolean = () => isSandboxAvailable(),
): void {
  if (!availabilityCheck()) {
    throw new Error(
      'Sandbox requested but macOS sandbox-exec is unavailable; refusing to run unsandboxed.',
    )
  }
}

/**
 * Resolves symlinks and canonicalizes a path, preserving any trailing non-existent segments.
 * @param input Path string to canonicalize.
 * @returns Canonicalized path.
 */
function canonicalizePath(input: string): string {
  const absolute = path.resolve(input)
  let existing = absolute
  const missingSegments: string[] = []

  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    missingSegments.unshift(path.basename(existing))
    existing = parent
  }

  const canonicalBase = realpathSync.native(existing)
  return path.join(canonicalBase, ...missingSegments)
}

/**
 * Expands '~' to homeDir, relative paths to repoRoot, and returns absolute paths unchanged.
 * @param input Raw path string.
 * @param repoRoot Absolute repo root path.
 * @param homeDir User home directory path.
 * @returns Expanded path string.
 */
function expandPath(input: string, repoRoot: string, homeDir: string): string {
  if (input === '~') return homeDir
  if (input.startsWith('~/')) return path.join(homeDir, input.slice(2))
  return path.isAbsolute(input) ? input : path.resolve(repoRoot, input)
}

/**
 * Deduplicates an array of strings while preserving insertion order.
 * @param items Array of strings.
 * @returns Deduplicated string array.
 */
function unique(items: string[]): string[] {
  return [...new Set(items)]
}

/**
 * Merges CLI flags, config file rules, and default security boundaries into a fully resolved sandbox configuration.
 * Sets up allowWrite paths (repoRoot, TMPDIR, /dev/null), denyRead paths (~/.ssh, ~/.aws, etc.), and protectedWrite (.octonoesis).
 * @param sources Configuration sources including repoRoot, CLI flags, config file, and environment overrides.
 * @returns Fully resolved ResolvedSandboxConfig.
 * @throws {Error} If per-domain network filtering is requested (unsupported).
 */
export function resolveSandboxConfig(sources: SandboxConfigSources): ResolvedSandboxConfig {
  const homeDir = canonicalizePath(sources.environment?.homeDir ?? process.env.HOME ?? os.homedir())
  const repoRoot = canonicalizePath(sources.repoRoot)
  const tmpDir = canonicalizePath(sources.environment?.tmpDir ?? process.env.TMPDIR ?? os.tmpdir())

  const allowWrite = unique([
    repoRoot,
    tmpDir,
    ...DEFAULT_ALLOW_WRITE.map((entry) =>
      entry.startsWith('/dev/') ? entry : canonicalizePath(entry),
    ),
    ...(sources.config?.filesystem?.allowWrite ?? []).map((entry) =>
      canonicalizePath(expandPath(entry, repoRoot, homeDir)),
    ),
  ])
  const denyRead = unique(
    [...DEFAULT_DENY_READ, ...(sources.config?.filesystem?.denyRead ?? [])].map((entry) =>
      canonicalizePath(expandPath(entry, repoRoot, homeDir)),
    ),
  )
  const allowedDomains = sources.config?.network?.allowedDomains
  if (
    allowedDomains &&
    allowedDomains.length > 0 &&
    !(allowedDomains.length === 1 && allowedDomains[0] === '*')
  ) {
    throw new Error(
      'Per-domain sandbox network filtering is not supported until v1.1; use [] or ["*"].',
    )
  }
  const resolvedAllowedDomains: [] | ['*'] =
    allowedDomains?.length === 1 && allowedDomains[0] === '*' ? ['*'] : []

  return {
    enabled: sources.cliEnabled === true || sources.config?.enabled === true,
    repoRoot,
    protectedWrite: canonicalizePath(path.join(repoRoot, '.octonoesis')),
    filesystem: { allowWrite, denyRead },
    network: { allowedDomains: resolvedAllowedDomains },
  }
}
