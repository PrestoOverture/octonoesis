import fs from 'node:fs/promises'
import path from 'node:path'
import { loadMemoryIndex } from '../memory/auto/store'
import type { MemoryFile } from '../memory/auto/types'
import type { Usage } from '../providers/types'
import type { QueryLoopContext } from '../query/types'
import { dbg } from '../utils/debug'
import {
  type CompiledContext,
  type ContextSource,
  DEFAULT_CONTEXT_BUDGET,
  compileContext,
} from './compiler'
import { buildDynamicSuffix } from './dynamic'
import { buildStaticPrompt } from './static'

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

export async function buildSessionContextSources(
  ctx: QueryLoopContext,
  model: string,
  usage: Usage,
  recalledMemories: MemoryFile[],
): Promise<ContextSource[]> {
  const [claudeMd, memoryIndex, dynamicSuffix] = await Promise.all([
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

  if (claudeMd !== undefined) {
    sources.push({
      id: 'claude_md',
      channel: 'systemStable',
      priority: 'high',
      content: `## Project Instructions (CLAUDE.md)\n${claudeMd}`,
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
): Promise<CompiledContext> {
  const sources = await buildSessionContextSources(ctx, model, usage, recalledMemories)
  const compiled = compileContext(sources, DEFAULT_CONTEXT_BUDGET)
  if (compiled.dropped.length > 0) {
    dbg('context', 'Context sources were truncated or dropped', {
      dropped: compiled.dropped,
    })
  }
  return compiled
}
