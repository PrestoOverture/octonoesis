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

/**
 * Checks whether the memory subsystem is disabled via OCTONOESIS_DISABLE_MEMORY.
 * @returns True if memory is disabled, false otherwise.
 */
function isMemoryDisabled(): boolean {
  const value = process.env.OCTONOESIS_DISABLE_MEMORY
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

/**
 * Reads the content of an optional file, returning undefined if it does not exist.
 * @param filePath Path to the file.
 * @returns The file content string or undefined if ENOENT.
 * @throws {Error} If reading fails for reasons other than ENOENT.
 */
async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Formats recalled long-term memory files into markdown sections for inclusion in the prompt.
 * @param memories Array of recalled MemoryFile objects.
 * @returns Formatted markdown string.
 */
function formatRelevantMemories(memories: MemoryFile[]): string {
  return memories
    .map((memory) => `## Relevant Memory: ${memory.name} (${memory.type})\n${memory.content}`)
    .join('\n\n')
}

/**
 * Formats available skills into a catalog section for the system prompt.
 * @param skills Array of loaded skill definitions.
 * @returns Markdown text listing available skills and invocation guidance.
 */
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

/**
 * Gathers and builds raw context sources (static prompt, CLAUDE.md / OCTONOESIS.md, memory index,
 * skills catalog, session start rules, recalled memories, and dynamic runtime suffix).
 * @param ctx Tool and query loop context.
 * @param model Active model identifier.
 * @param usage Current session token usage.
 * @param recalledMemories Array of auto-recalled memories.
 * @param skills Optional loaded skills list.
 * @param rules Optional active rule pool.
 * @returns An array of ContextSource objects tagged with priority and channel.
 */
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

/**
 * Assembles and compiles session context into cache-stable system prompt and dynamic preamble strings.
 * @param ctx Tool and query loop context.
 * @param model Active model identifier.
 * @param usage Current session token usage.
 * @param recalledMemories Array of auto-recalled memories.
 * @param skills Optional loaded skills list.
 * @param rules Optional active rule pool.
 * @returns Compiled context ready for model dispatch.
 */
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
