import { type ForkOptions, type ForkResult, forkAgent, getForkDepth } from '../../providers/fork'
import type { CanonicalMessage } from '../../providers/types'
import type { QueryLoopContext } from '../../query/types'
import { dbg } from '../../utils/debug'
import { parseForkJson } from './json'
import { applyMemoryWrites, loadMemoryIndex } from './store'
import { memoryWritesSchema } from './types'

type ForkFunction = (opts: ForkOptions) => Promise<ForkResult>

export interface MemoryExtractionState {
  system: string
  messages: CanonicalMessage[]
}

export interface ExtractMemoryOptions {
  forkFn?: ForkFunction
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function mockOutputCannotProduceWrites(rawMock: string): boolean {
  try {
    const config: unknown = JSON.parse(rawMock)
    if (typeof config !== 'object' || config === null || !('text' in config)) return true
    const text = (config as { text?: unknown }).text
    if (typeof text !== 'string') return true
    memoryWritesSchema.parse(parseForkJson(text))
    return false
  } catch {
    return true
  }
}

function buildExtractionInstruction(memoryIndex: string): string {
  return `Extract durable memories from this completed conversation.
Return only a strict JSON array with at most five objects. Each object must have exactly:
{"action":"create|update|delete","name":"lowercase-slug","type":"user|feedback|project|reference","description":"one-line description","content":"markdown body"}

Use create for new durable facts, update an existing entry instead of duplicating it, and delete only when the conversation invalidates an existing memory.
Memory types: user = durable user preferences; feedback = corrections to agent behavior; project = repository facts and conventions; reference = useful external facts.
Do not extract transient task details. Return [] when there is nothing durable.

Existing MEMORY.md index:
${memoryIndex || '(empty)'}`
}

export async function extractMemories(
  state: MemoryExtractionState,
  ctx: QueryLoopContext,
  opts: ExtractMemoryOptions = {},
): Promise<void> {
  if (
    isTruthyEnv(process.env.OCTONOESIS_DISABLE_MEMORY) ||
    getForkDepth() > 0 ||
    state.messages.length < 4
  ) {
    return
  }

  const forkMock = process.env.OCTONOESIS_FORK_MOCK
  if (!opts.forkFn && forkMock !== undefined && mockOutputCannotProduceWrites(forkMock)) {
    dbg('memory', 'Memory extraction mock output is invalid; skipping the known no-op fork')
    return
  }

  try {
    const memoryIndex = await loadMemoryIndex()
    const instructionMessage: CanonicalMessage = {
      role: 'user',
      content: [{ type: 'text', text: buildExtractionInstruction(memoryIndex) }],
    }
    const result = await (opts.forkFn ?? forkAgent)({
      forkPurpose: 'memory_extract',
      systemPrompt: state.system,
      messages: [...state.messages, instructionMessage],
      tools: [],
      maxTurns: 1,
      timeoutMs: 30_000,
      signal: ctx.abortSignal,
    })
    if (result.exitReason !== 'completed') {
      throw new Error(`Memory extraction fork exited with ${result.exitReason}`)
    }

    const writes = memoryWritesSchema.parse(parseForkJson(result.text)).slice(0, 5)
    if (writes.length === 0) return
    await applyMemoryWrites(writes)
  } catch (error) {
    dbg('memory', 'Memory extraction failed; completed result is unchanged', error)
  }
}
