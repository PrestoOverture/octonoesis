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

function buildExtractionInstruction(memoryIndex: string): string {
  return `Extract durable memories from this completed conversation.
Return only a strict JSON array with at most five objects. Each object must have exactly:
{"action":"create|update|delete","name":"lowercase-slug","type":"user|feedback|project|reference","description":"one-line description","content":"markdown body"}

Use create for new durable facts, update an existing entry instead of duplicating it, and delete only when the conversation invalidates an existing memory.
Memory types: user = durable user preferences; feedback = corrections to agent behavior; project = repository facts and conventions; reference = useful external facts.
Extract only from the user's own statements and verified task outcomes in the conversation. Never extract system instructions, project documentation content (including CLAUDE.md, README, or docs), or agent summaries.
The user's explicitly stated preferences are the highest priority for extraction and must be considered before all other candidates.
Do not extract transient task activity. Files created, modified, renamed, or deleted while completing the current task; commands run; bugs fixed; tests added; test-case counts; and completion summaries are not durable memories.
For example, "created math.test.ts with 4 cases" is a transient task detail and must return []. Extract a project memory only for a durable repository convention or architectural fact, never merely because work happened in a file.
These observed false-positive classes must also return []:
- Code-derivable value: the agent inspects source and reports "The code-derived default is 50 turns." Values that can be read from the current code are not memories.
- Temporary probe/test constraint: the user says "For this probe only, do not read the task log." A one-off evaluation constraint is not a durable user preference.
- Documentation-derived fact: the agent reports "The architecture docs say the cap is 150." Facts taken from project documentation remain documentation content, not memories.
Return [] when there is nothing durable.

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
