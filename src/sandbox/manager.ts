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
  /** Phase 33 can pass the parsed `.octonoesis/config.json` sandbox section here. */
  config?: SandboxConfig
  environment?: SandboxConfigEnvironment
}

export interface SandboxAvailabilityEnvironment {
  platform?: NodeJS.Platform
  findExecutable?: (name: string) => string | null
}

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

export function isSandboxAvailable(environment: SandboxAvailabilityEnvironment = {}): boolean {
  const platform = environment.platform ?? process.platform
  const lookup = environment.findExecutable ?? findExecutable
  return platform === 'darwin' && lookup('sandbox-exec') !== null
}

export function assertSandboxAvailable(
  availabilityCheck: () => boolean = () => isSandboxAvailable(),
): void {
  if (!availabilityCheck()) {
    throw new Error(
      'Sandbox requested but macOS sandbox-exec is unavailable; refusing to run unsandboxed.',
    )
  }
}

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

function expandPath(input: string, repoRoot: string, homeDir: string): string {
  if (input === '~') return homeDir
  if (input.startsWith('~/')) return path.join(homeDir, input.slice(2))
  return path.isAbsolute(input) ? input : path.resolve(repoRoot, input)
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}

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
