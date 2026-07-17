import fs from 'node:fs/promises'
import path from 'node:path'
import { loadMemoryIndex } from '../memory/auto/store'
import type { MemoryFile } from '../memory/auto/types'
import { formatSessionStartRules, selectSessionStartRules } from '../memory/rules/sessionStart'
import type { RuleFile } from '../memory/rules/types'
import type { Usage } from '../providers/types'
import type { QueryLoopContext } from '../query/types'
import type { SkillDefinition } from '../skills/types'
import { dbg } from '../utils/debug'
import {
  type CompiledContext,
  type ContextSource,
  DEFAULT_CONTEXT_BUDGET,
  compileContext,
} from './compiler'
import { buildDynamicSuffix } from './dynamic'
import { buildStaticPrompt } from './static'

// Mirrors the truthy-env convention in memory/auto/recall.ts's isTruthyEnv.
function isMemoryDisabled(): boolean {
  const value = process.env.OCTONOESIS_DISABLE_MEMORY
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function formatRelevantMemories(memories: MemoryFile[]): string {
  return memories
    .map((memory) => `## Relevant Memory: ${memory.name} (${memory.type})\n${memory.content}`)
    .join('\n\n')
}

export function formatSkillCatalog(skills: readonly SkillDefinition[]): string {
  const lines = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (skill) =>
        `- ${skill.name}: ${skill.description}${skill.context === 'fork' ? ' [fork]' : ''}`,
    )
  return [
    '## Skills',
    'Use the Skill tool to invoke a skill by name. Pass any user-supplied trailing text as args.',
    '',
    ...lines,
  ].join('\n')
}

export async function buildSessionContextSources(
  ctx: QueryLoopContext,
  model: string,
  usage: Usage,
  recalledMemories: MemoryFile[],
  skills: readonly SkillDefinition[] = [],
  rules: readonly RuleFile[] = [],
): Promise<ContextSource[]> {
  const [octonoesisMd, claudeMd, memoryIndex, dynamicSuffix] = await Promise.all([
    readOptionalFile(path.join(ctx.repoRoot, 'OCTONOESIS.md')),
    readOptionalFile(path.join(ctx.repoRoot, 'CLAUDE.md')),
    loadMemoryIndex(),
    buildDynamicSuffix(ctx, model, usage),
  ])

  const sources: ContextSource[] = [
    {
      id: 'static_prompt',
      channel: 'systemStable',
      priority: 'critical',
      content: buildStaticPrompt(),
    },
  ]

  const projectInstructions = octonoesisMd ?? claudeMd
  if (ctx.config?.projectInstructions !== 'off' && projectInstructions !== undefined) {
    const sourceName = octonoesisMd !== undefined ? 'OCTONOESIS.md' : 'CLAUDE.md'
    sources.push({
      id: 'claude_md',
      channel: 'systemStable',
      priority: 'high',
      content: `## Project Instructions (${sourceName})\n${projectInstructions}`,
    })
  }
  if (memoryIndex.length > 0) {
    sources.push({
      id: 'memory_index',
      channel: 'systemStable',
      priority: 'high',
      content: memoryIndex,
    })
  }
  if (skills.length > 0) {
    sources.push({
      id: 'skill_catalog',
      channel: 'systemStable',
      priority: 'low',
      content: formatSkillCatalog(skills),
    })
  }
  if (!isMemoryDisabled()) {
    const sessionStartRules = formatSessionStartRules(selectSessionStartRules(rules))
    if (sessionStartRules.length > 0) {
      sources.push({
        id: 'active_rules',
        channel: 'systemStable',
        priority: 'medium',
        content: sessionStartRules,
      })
    }
  }
  if (recalledMemories.length > 0) {
    sources.push({
      id: 'relevant_memories',
      channel: 'preamble',
      priority: 'medium',
      content: formatRelevantMemories(recalledMemories),
    })
  }
  sources.push({
    id: 'dynamic_suffix',
    channel: 'preamble',
    priority: 'low',
    content: dynamicSuffix,
  })

  return sources
}

export async function assembleSessionContext(
  ctx: QueryLoopContext,
  model: string,
  usage: Usage,
  recalledMemories: MemoryFile[],
  skills: readonly SkillDefinition[] = [],
  rules: readonly RuleFile[] = [],
): Promise<CompiledContext> {
  const sources = await buildSessionContextSources(
    ctx,
    model,
    usage,
    recalledMemories,
    skills,
    rules,
  )
  const compiled = compileContext(sources, DEFAULT_CONTEXT_BUDGET)
  if (compiled.dropped.length > 0) {
    dbg('context', 'Context sources were truncated or dropped', {
      dropped: compiled.dropped,
    })
  }
  return compiled
}
