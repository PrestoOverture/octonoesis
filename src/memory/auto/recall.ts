import { z } from 'zod'
import { type ForkOptions, type ForkResult, forkAgent } from '../../providers/fork'
import { dbg } from '../../utils/debug'
import { parseForkJson } from './json'
import type { MemoryFile } from './types'

type ForkFunction = (opts: ForkOptions) => Promise<ForkResult>

export interface RecallOptions {
  systemPrompt?: string
  signal?: AbortSignal
  forkFn?: ForkFunction
}

const recalledNamesSchema = z.array(z.string())

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function buildRecallInstruction(query: string, memories: MemoryFile[]): string {
  const indexLines = memories.map((memory) => `${memory.name}: ${memory.description}`).join('\n')
  return `Choose the memories most relevant to the user's query.
Return only a strict JSON array of memory names, ordered most relevant first. Return [] when none apply.

Query:
${query}

Available memories:
${indexLines}`
}

export async function findRelevantMemories(
  query: string,
  memories: MemoryFile[],
  opts: RecallOptions = {},
): Promise<MemoryFile[]> {
  if (memories.length === 0 || isTruthyEnv(process.env.OCTONOESIS_DISABLE_MEMORY)) return []

  try {
    const result = await (opts.forkFn ?? forkAgent)({
      forkPurpose: 'memory_recall',
      systemPrompt: opts.systemPrompt ?? '',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: buildRecallInstruction(query, memories) }],
        },
      ],
      tools: [],
      maxTurns: 1,
      timeoutMs: 15_000,
      signal: opts.signal,
    })
    if (result.exitReason !== 'completed') {
      throw new Error(`Memory recall fork exited with ${result.exitReason}`)
    }

    const names = recalledNamesSchema.parse(parseForkJson(result.text))
    const byName = new Map(memories.map((memory) => [memory.name, memory]))
    const seen = new Set<string>()
    const recalled: MemoryFile[] = []
    for (const name of names) {
      const memory = byName.get(name)
      if (!memory || seen.has(name)) continue
      recalled.push(memory)
      seen.add(name)
      if (recalled.length === 5) break
    }
    return recalled
  } catch (error) {
    dbg('memory', 'Memory recall failed; continuing without recalled memories', error)
    return []
  }
}
