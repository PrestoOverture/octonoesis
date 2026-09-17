import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { getMemoryDir } from '../utils/path'
import { DEFAULT_ALLOW_WRITE, type ResolvedSandboxConfig } from './types'

const DEVICE_LITERALS = new Set(DEFAULT_ALLOW_WRITE.filter((entry) => entry.startsWith('/dev/')))

/**
 * Escapes a string for safe inclusion in an Apple Seatbelt Profile Language (SBPL) definition.
 *
 * @param value - String value or path to escape.
 * @returns Escaped string safe for SBPL double-quoted strings.
 * @throws Error If the string contains NUL (`\0`) or newline characters.
 */
function escapeSbplString(value: string): string {
  if (value.includes('\u0000') || value.includes('\r') || value.includes('\n')) {
    throw new Error('Sandbox paths may not contain NUL or newline characters.')
  }
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/**
 * Generates an SBPL path selector entry for a literal or subpath match.
 *
 * @param kind - Match kind (`'literal'` or `'subpath'`).
 * @param value - Path string to match.
 * @returns Formatted SBPL selector line.
 */
function selector(kind: 'literal' | 'subpath', value: string): string {
  return `  (${kind} "${escapeSbplString(value)}")`
}

/**
 * Generates SBPL path selectors for an array of filesystem paths.
 *
 * @param paths - Target paths to format.
 * @param deviceLiterals - When true, paths matching known device files (`/dev/*`) emit only literal selectors rather than both literal and subpath selectors.
 * @returns Array of SBPL selector expressions.
 */
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
 *
 * @param config - Resolved sandbox configuration specifying allowed/denied paths and network rules.
 * @returns Serialized Seatbelt Profile Language (SBPL) configuration string.
 */
export function buildProfile(config: ResolvedSandboxConfig): string {
  const memoryDir = path.resolve(getMemoryDir())
  const resolvedMemoryDir = existsSync(memoryDir) ? realpathSync.native(memoryDir) : memoryDir
  const protectedWrites = [...new Set([config.protectedWrite, resolvedMemoryDir])]
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...pathSelectors(config.filesystem.allowWrite, true),
    ')',
    '(deny file-write*',
    ...pathSelectors(protectedWrites),
    ')',
    '(deny file-read*',
    ...pathSelectors(config.filesystem.denyRead),
    ')',
    config.network.allowedDomains.length === 0 ? '(deny network*)' : '(allow network*)',
  ]

  return `${lines.join('\n')}\n`
}

/**
 * Wraps a shell command execution array with macOS `sandbox-exec` and an SBPL security profile.
 *
 * @param command - Raw bash command to execute in the sandbox.
 * @param config - Resolved sandbox configuration to generate the profile from.
 * @returns Command argument array invoking `sandbox-exec` with the generated profile and command.
 */
export function wrapWithSandbox(command: string, config: ResolvedSandboxConfig): string[] {
  return ['sandbox-exec', '-p', buildProfile(config), 'bash', '-c', command]
}
