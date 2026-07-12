import type { SandboxConfig } from '../query/types'

export const DEFAULT_DENY_READ = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config/gcloud',
  '~/.kube',
  '~/.docker',
  '~/Library/Keychains',
  '~/.netrc',
] as const

/** Static entries in the default write policy; repoRoot and TMPDIR are added when resolved. */
export const DEFAULT_ALLOW_WRITE = [
  '/private/tmp',
  '/dev/null',
  '/dev/tty',
  '/dev/stdout',
  '/dev/stderr',
] as const

export interface ResolvedSandboxConfig extends SandboxConfig {
  repoRoot: string
  protectedWrite: string
  filesystem: {
    allowWrite: string[]
    denyRead: string[]
  }
  network: {
    allowedDomains: [] | ['*']
  }
}
