import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dbg } from '../utils/debug'
import { bundledSkills } from './bundled'
import type { SkillContext, SkillDefinition, SkillSource } from './types'

const SKILL_SLUG = /^[a-z0-9][a-z0-9-]*$/
const cache = new Map<string, Promise<SkillDefinition[]>>()

export interface LoadSkillsOptions {
  homeDir?: string
}

/**
 * Strips matching surrounding single or double quotes and leading/trailing whitespace from a YAML scalar value.
 *
 * @param value - Raw YAML scalar string.
 * @returns Clean unquoted string.
 */
function scalar(value: string): string {
  const trimmed = value.trim()
  const quoted = trimmed.match(/^(['"])(.*)\1$/)
  return quoted?.[2] ?? trimmed
}

/**
 * Parses a simple bracketed comma-separated list of strings from frontmatter YAML (e.g. `[Read, Grep]`).
 *
 * @param value - Raw YAML string.
 * @returns Array of parsed string items, or undefined if parsing failed or invalid format.
 */
function stringList(value: string): string[] | undefined {
  const match = value.trim().match(/^\[(.*)\]$/)
  if (!match) return undefined
  const body = match[1] ?? ''
  if (!body.trim()) return []
  const values = body.split(',').map(scalar)
  return values.every(Boolean) ? values : undefined
}

/**
 * Parses a skill Markdown file containing YAML frontmatter into a validated SkillDefinition.
 *
 * @param name - Derived skill name slug.
 * @param filePath - Filesystem path to the skill file.
 * @param source - Provenance category (`'bundled'`, `'user'`, or `'project'`).
 * @param raw - Raw file text containing frontmatter and body.
 * @returns Validated SkillDefinition or undefined if frontmatter is missing or invalid.
 */
function parseSkill(
  name: string,
  filePath: string,
  source: SkillSource,
  raw: string,
): SkillDefinition | undefined {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (!match) return undefined

  const fields = new Map<string, string>()
  const frontmatter = match[1] ?? ''
  const content = match[2] ?? ''
  for (const line of frontmatter.split(/\r?\n/)) {
    const pair = line.match(/^([a-z][a-z-]*):\s*(.*)$/)
    const key = pair?.[1]
    const value = pair?.[2]
    if (key !== undefined && value !== undefined) fields.set(key, value)
  }

  const description = scalar(fields.get('description') ?? '')
  const contextValue = scalar(fields.get('context') ?? 'inline')
  if (!description || (contextValue !== 'inline' && contextValue !== 'fork')) return undefined
  const context = contextValue as SkillContext
  const allowedTools = fields.has('allowed-tools')
    ? stringList(fields.get('allowed-tools') ?? '')
    : undefined
  if (context === 'fork' && fields.has('allowed-tools') && allowedTools === undefined)
    return undefined
  const model = scalar(fields.get('model') ?? '')

  return {
    name,
    description,
    context,
    ...(context === 'fork' && allowedTools ? { allowedTools } : {}),
    ...(context === 'fork' && model ? { model } : {}),
    content: content.trim(),
    source,
    path: filePath,
  }
}

/**
 * Scans a directory for valid `.md` skill files and parses them into SkillDefinition records.
 *
 * @param dir - Target directory path to scan.
 * @param source - Provenance category for skills discovered in this directory.
 * @returns Array of loaded SkillDefinition objects.
 */
async function scanDirectory(dir: string, source: SkillSource): Promise<SkillDefinition[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    dbg('skills', 'Failed to scan skill directory', { dir, error })
    return []
  }

  const skills: SkillDefinition[] = []
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== '.md') continue
    const name = path.basename(entry.name, '.md')
    if (!SKILL_SLUG.test(name)) {
      dbg('skills', 'Skipping skill with invalid slug', { name, dir })
      continue
    }
    const filePath = path.join(dir, entry.name)
    try {
      const parsed = parseSkill(name, filePath, source, await fs.readFile(filePath, 'utf8'))
      if (parsed) skills.push(parsed)
      else dbg('skills', 'Skipping malformed skill', { name, filePath })
    } catch (error) {
      dbg('skills', 'Failed to load skill', { name, filePath, error })
    }
  }
  return skills
}

/**
 * Scans bundled, user-level, and project-level skill directories and merges them in priority order.
 * Project skills override user skills, which override bundled skills with the same name.
 *
 * @param repoRoot - Repository root directory path.
 * @param homeDir - User home directory path.
 * @returns Alphabetically sorted array of deduplicated skill definitions.
 */
async function scanSkills(repoRoot: string, homeDir: string): Promise<SkillDefinition[]> {
  const [user, project] = await Promise.all([
    scanDirectory(path.join(homeDir, '.octonoesis', 'skills'), 'user'),
    scanDirectory(path.join(repoRoot, '.octonoesis', 'skills'), 'project'),
  ])
  const merged = new Map<string, SkillDefinition>()
  for (const skill of bundledSkills) merged.set(skill.name, skill)
  for (const skill of user) merged.set(skill.name, skill)
  for (const skill of project) merged.set(skill.name, skill)
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Loads the immutable skill catalog once per repository root for this process, caching the result.
 *
 * @param repoRoot - Repository root path.
 * @param options - Optional loader configuration such as custom home directory.
 * @returns Promise resolving to the list of available skill definitions.
 */
export function loadSkills(
  repoRoot: string,
  options: LoadSkillsOptions = {},
): Promise<SkillDefinition[]> {
  const key = path.resolve(repoRoot)
  let pending = cache.get(key)
  if (!pending) {
    pending = scanSkills(key, options.homeDir ?? os.homedir())
    cache.set(key, pending)
  }
  return pending
}

/**
 * Clears the internal skill catalog cache for testing purposes.
 */
export function clearSkillCacheForTesting(): void {
  cache.clear()
}
