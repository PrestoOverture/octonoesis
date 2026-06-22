import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getMemoryDir } from '../../utils/path.ts'
import type { RuleFile } from './types.ts'
import { calculateConfidence } from './types.ts'

export function getRulesDir(): string {
  return path.join(getMemoryDir(), 'rules')
}

/**
 * Serializes a RuleFile object to a YAML-frontmatter markdown string.
 */
export function serializeRule(rule: RuleFile): string {
  const frontmatter = [
    `id: ${rule.id}`,
    'triggers:',
    '  tools:',
    ...rule.triggers.tools.map((t) => `    - ${t}`),
    '  command_prefix:',
    ...rule.triggers.command_prefix.map((p) => `    - ${p}`),
    '  error_signatures:',
    ...rule.triggers.error_signatures.map((s) => `    - ${s}`),
    `scope: ${rule.scope}`,
    `alpha: ${rule.alpha}`,
    `beta: ${rule.beta}`,
    `confidence: ${rule.confidence}`,
    'evidence:',
    ...rule.evidence.map((e) => `  - ${e}`),
    `hits: ${rule.hits}`,
    `misses: ${rule.misses}`,
    'challenged_by:',
    ...rule.challenged_by.map((c) => `  - ${c}`),
    'anchor:',
    `  file: ${rule.anchor.file}`,
    `status: ${rule.status}`,
    `user_confirmed: ${rule.user_confirmed}`,
    `extractor_version: ${rule.extractor_version}`,
    `model_id: ${rule.model_id}`,
    `prompt_hash: ${rule.prompt_hash}`,
    `created_at: ${rule.created_at}`,
    `last_matched_at: ${rule.last_matched_at ? rule.last_matched_at : 'null'}`,
    `last_rebuilt_at: ${rule.last_rebuilt_at ? rule.last_rebuilt_at : 'null'}`,
  ].join('\n')

  return `---\n${frontmatter}\n---\n\n${rule.advice}`
}

/**
 * Parses a YAML-frontmatter markdown string into a RuleFile object.
 */
export function parseRule(content: string): RuleFile {
  const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
  const match = content.match(fmRegex)
  if (!match) {
    throw new Error('Invalid rule file structure: missing frontmatter block')
  }

  const fmText = match[1]
  const advice = match[2]
  if (fmText === undefined || advice === undefined) {
    throw new Error('Invalid rule file structure: missing frontmatter block')
  }

  const adviceTrimmed = advice.trim()
  const lines = fmText.split(/\r?\n/)
  // biome-ignore lint/suspicious/noExplicitAny: custom parsed structure
  const result: any = {
    triggers: { tools: [], command_prefix: [], error_signatures: [] },
    evidence: [],
    challenged_by: [],
    anchor: { file: '' },
  }

  const parsedKeys = new Set<string>()
  const parsedTriggersKeys = new Set<string>()
  const parsedAnchorKeys = new Set<string>()

  let currentKey = ''
  let subKey = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (trimmed.startsWith('-')) {
      const val = trimmed.slice(1).trim()
      const cleanVal = val.replace(/^['"](.*)['"]$/, '$1')

      if (currentKey === 'triggers') {
        if (subKey === 'tools') result.triggers.tools.push(cleanVal)
        else if (subKey === 'command_prefix') result.triggers.command_prefix.push(cleanVal)
        else if (subKey === 'error_signatures') result.triggers.error_signatures.push(cleanVal)
      } else if (currentKey === 'evidence') {
        result.evidence.push(cleanVal)
      } else if (currentKey === 'challenged_by') {
        result.challenged_by.push(cleanVal)
      }
      continue
    }

    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const rawKey = line.slice(0, colonIndex).trim()
    const rawVal = line.slice(colonIndex + 1).trim()
    const cleanVal = rawVal.replace(/^['"](.*)['"]$/, '$1')

    const indent = line.length - line.trimStart().length

    if (indent === 0) {
      currentKey = rawKey
      subKey = ''
      parsedKeys.add(rawKey)
      if (rawVal) {
        if (currentKey === 'id') result.id = cleanVal
        else if (currentKey === 'scope') result.scope = cleanVal
        else if (currentKey === 'alpha') result.alpha = Number.parseInt(cleanVal, 10)
        else if (currentKey === 'beta') result.beta = Number.parseInt(cleanVal, 10)
        else if (currentKey === 'confidence') result.confidence = Number.parseFloat(cleanVal)
        else if (currentKey === 'hits') result.hits = Number.parseInt(cleanVal, 10)
        else if (currentKey === 'misses') result.misses = Number.parseInt(cleanVal, 10)
        else if (currentKey === 'status') result.status = cleanVal
        else if (currentKey === 'user_confirmed') result.user_confirmed = cleanVal === 'true'
        else if (currentKey === 'extractor_version') result.extractor_version = cleanVal
        else if (currentKey === 'model_id') result.model_id = cleanVal
        else if (currentKey === 'prompt_hash') result.prompt_hash = cleanVal
        else if (currentKey === 'created_at') result.created_at = cleanVal
        else if (currentKey === 'last_matched_at') {
          result.last_matched_at = cleanVal === 'null' ? null : cleanVal
        } else if (currentKey === 'last_rebuilt_at') {
          result.last_rebuilt_at = cleanVal === 'null' ? null : cleanVal
        }
      }
    } else if (indent === 2) {
      if (currentKey === 'triggers') {
        subKey = rawKey
        parsedTriggersKeys.add(rawKey)
      } else if (currentKey === 'anchor') {
        parsedAnchorKeys.add(rawKey)
        if (rawKey === 'file') {
          result.anchor.file = cleanVal
        }
      }
    }
  }

  const requiredKeys = [
    'id',
    'triggers',
    'scope',
    'confidence',
    'evidence',
    'hits',
    'misses',
    'challenged_by',
    'anchor',
    'status',
    'user_confirmed',
    'extractor_version',
    'model_id',
    'prompt_hash',
    'created_at',
    'last_matched_at',
    'last_rebuilt_at',
  ]
  for (const k of requiredKeys) {
    if (!parsedKeys.has(k)) {
      throw new Error(`Missing required frontmatter key: ${k}`)
    }
  }

  const requiredTriggersKeys = ['tools', 'command_prefix', 'error_signatures']
  for (const k of requiredTriggersKeys) {
    if (!parsedTriggersKeys.has(k)) {
      throw new Error(`Missing required triggers subkey: ${k}`)
    }
  }

  if (!parsedAnchorKeys.has('file')) {
    throw new Error('Missing required anchor subkey: file')
  }

  const validStatuses = new Set([
    'candidate',
    'active',
    'retired',
    'dormant',
    'pinned',
    'banned',
    'superseded',
  ])
  if (!validStatuses.has(result.status)) {
    throw new Error(`Invalid status value: ${result.status}`)
  }

  if (result.scope !== 'repo' && result.scope !== 'global') {
    throw new Error(`Invalid scope value: ${result.scope}`)
  }

  if (typeof result.confidence !== 'number' || Number.isNaN(result.confidence)) {
    throw new Error('Invalid confidence value')
  }

  if (typeof result.user_confirmed !== 'boolean') {
    throw new Error('Invalid user_confirmed value')
  }

  const cleanHits = result.hits ?? 0
  const cleanMisses = result.misses ?? 0
  const cleanEvidence = result.evidence ?? []

  const alpha =
    result.alpha !== undefined && !Number.isNaN(result.alpha)
      ? result.alpha
      : 2 + cleanHits + cleanEvidence.length
  const beta =
    result.beta !== undefined && !Number.isNaN(result.beta) ? result.beta : 2 + cleanMisses
  const confidence = calculateConfidence(alpha, beta)

  return {
    id: result.id,
    triggers: result.triggers,
    scope: result.scope,
    alpha,
    beta,
    confidence,
    evidence: cleanEvidence,
    hits: cleanHits,
    misses: cleanMisses,
    challenged_by: result.challenged_by,
    anchor: result.anchor,
    status: result.status,
    user_confirmed: result.user_confirmed,
    extractor_version: result.extractor_version,
    model_id: result.model_id,
    prompt_hash: result.prompt_hash,
    created_at: result.created_at,
    last_matched_at: result.last_matched_at,
    last_rebuilt_at: result.last_rebuilt_at,
    advice: adviceTrimmed,
  }
}

/**
 * Saves a single rule file to disk.
 */
export async function saveRule(rule: RuleFile, rulesDir: string = getRulesDir()): Promise<void> {
  await mkdir(rulesDir, { recursive: true })
  const filePath = path.join(rulesDir, `${rule.id}.md`)
  const content = serializeRule(rule)
  await writeFile(filePath, content, 'utf-8')
}

export async function loadRule(
  ruleId: string,
  rulesDir: string = getRulesDir(),
): Promise<RuleFile | null> {
  const filePath = path.join(rulesDir, `${ruleId}.md`)
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string }
    if (error && (error.code === 'ENOENT' || error.message?.includes('ENOENT'))) {
      return null
    }
    throw err
  }
  return parseRule(content)
}

/**
 * Loads all rules from the rules directory.
 */
export async function loadAllRules(rulesDir: string = getRulesDir()): Promise<RuleFile[]> {
  let files: string[]
  try {
    files = await readdir(rulesDir)
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string }
    if (error && (error.code === 'ENOENT' || error.message?.includes('ENOENT'))) {
      return []
    }
    throw err
  }

  const ruleFiles = files.filter((f) => f.startsWith('rule-') && f.endsWith('.md'))
  const rules: RuleFile[] = []
  for (const f of ruleFiles) {
    const ruleId = f.slice(0, -3) // remove .md
    const rule = await loadRule(ruleId, rulesDir)
    if (rule) {
      rules.push(rule)
    }
  }
  return rules
}
