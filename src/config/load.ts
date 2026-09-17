import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { ConfigValidationError, DEFAULT_CONFIG, type OctonoesisConfig, parseConfig } from './schema'

const execFileAsync = promisify(execFile)

interface ConfigCacheEntry {
  config: Promise<OctonoesisConfig>
  tracked: Promise<boolean>
}

const cache = new Map<string, ConfigCacheEntry>()

/**
 * Computes the absolute filesystem path to .octonoesis/config.json for a repository root.
 * @param repoRoot Absolute path to the repository root.
 * @returns Path to the config file.
 */
function configPathFor(repoRoot: string): string {
  return path.join(repoRoot, '.octonoesis', 'config.json')
}

/**
 * Reads and parses the repository's configuration file, returning DEFAULT_CONFIG if the file is missing.
 * @param repoRoot Absolute path to the repository root.
 * @returns A promise resolving to the validated OctonoesisConfig.
 * @throws {ConfigValidationError} If the JSON syntax is malformed or schema validation fails.
 */
async function readConfig(repoRoot: string): Promise<OctonoesisConfig> {
  const configPath = configPathFor(repoRoot)
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return DEFAULT_CONFIG
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ConfigValidationError([
      `${configPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ])
  }
  return parseConfig(parsed)
}

/**
 * Checks whether .octonoesis/config.json is tracked by Git in the repository.
 * Tracked configs in public or untrusted repos require explicit user trust.
 * @param repoRoot Absolute path to the repository root.
 * @returns True if git tracks the config file, false otherwise.
 */
async function checkTracked(repoRoot: string): Promise<boolean> {
  try {
    await execFileAsync('git', [
      '-C',
      repoRoot,
      'ls-files',
      '--error-unmatch',
      '--',
      '.octonoesis/config.json',
    ])
    return true
  } catch {
    return false
  }
}

/**
 * Retrieves or initializes the memoized configuration and tracking status cache entry for a repository.
 * @param repoRoot Absolute path to the repository root.
 * @returns The cached ConfigCacheEntry promises.
 */
function entryFor(repoRoot: string): ConfigCacheEntry {
  const key = path.resolve(repoRoot)
  let entry = cache.get(key)
  if (!entry) {
    entry = {
      config: readConfig(key),
      tracked: checkTracked(key),
    }
    cache.set(key, entry)
  }
  return entry
}

/**
 * Loads and returns the validated configuration for a repository root (memoized per repoRoot).
 * @param repoRoot Absolute path to the repository root.
 * @returns The loaded OctonoesisConfig.
 */
export async function loadConfig(repoRoot: string): Promise<OctonoesisConfig> {
  return entryFor(repoRoot).config
}

/**
 * Determines whether the repository's configuration file is tracked in Git (memoized per repoRoot).
 * @param repoRoot Absolute path to the repository root.
 * @returns True if tracked by Git, false otherwise.
 */
export async function isConfigTracked(repoRoot: string): Promise<boolean> {
  return entryFor(repoRoot).tracked
}

/**
 * Evaluates whether the loaded configuration is trusted for privileged features
 * (such as shell hooks, MCP servers, and auto-allow permission patterns).
 * An untracked config is trusted by default; a git-tracked config requires trustTrackedConfig: true.
 * @param repoRoot Absolute path to the repository root.
 * @param config The active configuration object.
 * @returns True if the config is trusted, false if untrusted.
 */
export async function isActiveConfigTrusted(
  repoRoot: string,
  config: OctonoesisConfig,
): Promise<boolean> {
  return !(await isConfigTracked(repoRoot)) || config.trustTrackedConfig
}

/**
 * Returns a human-readable security warning message if the active configuration is untrusted.
 * @param repoRoot Absolute path to the repository root.
 * @param config The active configuration object.
 * @returns A warning string if untrusted, or undefined if trusted.
 */
export async function getConfigTrustWarning(
  repoRoot: string,
  config: OctonoesisConfig,
): Promise<string | undefined> {
  if (await isActiveConfigTrusted(repoRoot, config)) return undefined
  return 'Warning: tracked .octonoesis/config.json is untrusted; shell hooks, MCP servers, and permission allowPatterns are disabled. Set trustTrackedConfig: true to override.'
}

/**
 * Clears the in-memory configuration cache for test isolation.
 */
export function clearConfigCacheForTests(): void {
  cache.clear()
}
