import { DEFAULT_ALLOW_WRITE, type ResolvedSandboxConfig } from './types'

const DEVICE_LITERALS = new Set(DEFAULT_ALLOW_WRITE.filter((entry) => entry.startsWith('/dev/')))

function escapeSbplString(value: string): string {
  if (value.includes('\u0000') || value.includes('\r') || value.includes('\n')) {
    throw new Error('Sandbox paths may not contain NUL or newline characters.')
  }
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function selector(kind: 'literal' | 'subpath', value: string): string {
  return `  (${kind} "${escapeSbplString(value)}")`
}

function pathSelectors(paths: string[], deviceLiterals = false): string[] {
  return paths.flatMap((path) => {
    if (deviceLiterals && DEVICE_LITERALS.has(path as (typeof DEFAULT_ALLOW_WRITE)[number])) {
      return [selector('literal', path)]
    }
    return [selector('literal', path), selector('subpath', path)]
  })
}

/**
 * Builds a targeted-deny Seatbelt profile. This intentionally is not a minimal-privilege profile:
 * operations stay allowed by default while writes, sensitive reads, and network access are confined.
 */
export function buildProfile(config: ResolvedSandboxConfig): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...pathSelectors(config.filesystem.allowWrite, true),
    ')',
    '(deny file-write*',
    ...pathSelectors([config.protectedWrite]),
    ')',
    '(deny file-read*',
    ...pathSelectors(config.filesystem.denyRead),
    ')',
    config.network.allowedDomains.length === 0 ? '(deny network*)' : '(allow network*)',
  ]

  return `${lines.join('\n')}\n`
}

export function wrapWithSandbox(command: string, config: ResolvedSandboxConfig): string[] {
  return ['sandbox-exec', '-p', buildProfile(config), 'bash', '-c', command]
}
