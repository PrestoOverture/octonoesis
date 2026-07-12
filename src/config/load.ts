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

function configPathFor(repoRoot: string): string {
  return path.join(repoRoot, '.octonoesis', 'config.json')
}

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

export async function loadConfig(repoRoot: string): Promise<OctonoesisConfig> {
  return entryFor(repoRoot).config
}

export async function isConfigTracked(repoRoot: string): Promise<boolean> {
  return entryFor(repoRoot).tracked
}

export async function isActiveConfigTrusted(
  repoRoot: string,
  config: OctonoesisConfig,
): Promise<boolean> {
  return !(await isConfigTracked(repoRoot)) || config.trustTrackedConfig
}

export async function getConfigTrustWarning(
  repoRoot: string,
  config: OctonoesisConfig,
): Promise<string | undefined> {
  if (await isActiveConfigTrusted(repoRoot, config)) return undefined
  return 'Warning: tracked .octonoesis/config.json is untrusted; shell hooks and permission allowPatterns are disabled. Set trustTrackedConfig: true to override.'
}

export function clearConfigCacheForTests(): void {
  cache.clear()
}
