import { formatMemoryUnavailableNotice } from './memory/availability'
import { flushJournal, formatJournalFailureNotice } from './memory/journal'
import { query } from './query'
import type { QueryLoopContext, QueryResultV1 } from './query/types'
import { flushSessionStats } from './state/session'
import { cleanupTasks } from './tasks/framework'
import { dbg } from './utils/debug'

export interface HeadlessResult {
  exit_reason: QueryResultV1['exit_reason']
  turns: number
  usage: QueryResultV1['usage']
  duration_ms: number
  tool_calls: { name: string; ok: boolean }[]
  final_text: string
  session_id: string
}

/** Consume engine events without rendering; publish one result after session cleanup. */
export async function runJsonQuery(
  prompt: string,
  ctx: QueryLoopContext & { sessionId: string },
  signal?: AbortSignal,
): Promise<void> {
  const start = performance.now()
  const toolCalls: HeadlessResult['tool_calls'] = []
  let result: QueryResultV1
  try {
    const generator = query(prompt, ctx, signal)
    while (true) {
      const step = await generator.next()
      if (step.done) {
        result = step.value
        break
      }
      if (step.value.type === 'tool_done') {
        toolCalls.push({ name: step.value.name, ok: step.value.status === 'done' })
      }
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    result = {
      exit_reason: signal?.aborted ? 'user_cancel' : 'fatal_error',
      turns: ctx.sessionState?.turns ?? 0,
      usage: ctx.sessionState?.usage ?? { input_tokens: 0, output_tokens: 0 },
    }
  } finally {
    try {
      await cleanupTasks(ctx)
    } catch (error) {
      dbg('cli', 'Failed to clean up background tasks', error)
    }
    await flushSessionStats()
    await flushJournal()
    const memoryNotice = formatMemoryUnavailableNotice()
    if (memoryNotice) console.error(memoryNotice)
    const journalNotice = formatJournalFailureNotice()
    if (journalNotice) console.error(journalNotice)
  }
  const output: HeadlessResult = {
    exit_reason: result.exit_reason,
    turns: result.turns,
    usage: result.usage,
    duration_ms: Math.round(performance.now() - start),
    tool_calls: toolCalls,
    final_text: result.final_message ?? '',
    session_id: ctx.sessionId,
  }
  if (result.exit_reason !== 'completed' && result.exit_reason !== 'user_cancel') {
    process.exitCode = 1
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}
