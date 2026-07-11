import crypto from 'node:crypto'
import { extractMemories } from '../memory/auto/extract'
import { findRelevantMemories } from '../memory/auto/recall'
import { loadMemories } from '../memory/auto/store'
import { runSessionEndCalibration } from '../memory/calibration/hook'
import { runSessionEndEpisodes } from '../memory/episodes/hook'
import { appendJournal, flushJournal, setSessionId } from '../memory/journal'
import { updateLifecycle } from '../memory/rules/lifecycle'
import { findMatchingRules, formatMatchAdvice } from '../memory/rules/match'
import { loadAllRules, saveRule } from '../memory/rules/store'
import type { RuleFile } from '../memory/rules/types'
import { assembleSessionContext } from '../prompts/context'
import { buildStaticPrompt } from '../prompts/static'
import { getProvider, getResolvedModel } from '../providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  ContentBlock,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
  Usage,
} from '../providers'
import { bashTool } from '../tools/Bash'
import { editTool } from '../tools/Edit'
import { globTool } from '../tools/Glob'
import { grepTool } from '../tools/Grep'
import { readTool } from '../tools/Read'
import { todoWriteTool } from '../tools/TodoWrite'
import type { ToolContext } from '../tools/Tool'
import { writeTool } from '../tools/Write'
import { runTool } from '../tools/execute'
import { getAllTools, registerTool } from '../tools/registry'
import { dbg } from '../utils/debug'
import { getRepoRoot } from '../utils/path'
import { zodToJsonSchema } from '../utils/schema'
import type { ContextSnapshot } from '../utils/tokens'
import { totalTokensFromUsage } from '../utils/tokens'
import {
  CompactAbortError,
  CompactError,
  compact,
  createCompactSummaryMessage,
  selectKeepTail,
  shouldCompact,
} from './compact'
import type { ExitReason, QueryLoopContext, QueryResultV1, QueryState } from './types'

const MAX_TURNS = 50

registerTool(readTool)
registerTool(globTool)
registerTool(bashTool)
registerTool(writeTool)
registerTool(editTool)
registerTool(grepTool)
registerTool(todoWriteTool)

export type StreamEvent =
  | ProviderStreamEvent
  | { type: 'tool_done'; id: string; name: string; status: 'done' | 'error' }
  | { type: 'compact'; preTokens: number; postTokens: number; durationMs: number }

export type QueryResult = QueryResultV1

export type EngineState = QueryState & {
  input: string
  inputDigest: string
  rules: RuleFile[]
  contextSnapshot?: ContextSnapshot
  provider?: LLMProvider
  system?: string
  dynamicSystem?: string
  tools?: CanonicalTool[]
  compactConsecutiveFailures: number
  compactCircuitOpen: boolean
}

type ReadyEngineState = EngineState & {
  provider: LLMProvider
  system: string
  dynamicSystem: string
  tools: CanonicalTool[]
}

export interface AssembledContext {
  system: string
  dynamicSystem: string
  tools: CanonicalTool[]
  messages: CanonicalMessage[]
}

type StreamPhaseResult =
  | { kind: 'complete'; assistantBlocks: ContentBlock[] }
  | { kind: 'exit'; result: QueryResult }

function addUsage(target: Usage, usage: Usage): void {
  target.input_tokens += usage.input_tokens
  target.output_tokens += usage.output_tokens
  if (usage.cache_creation_input_tokens !== undefined) {
    target.cache_creation_input_tokens =
      (target.cache_creation_input_tokens ?? 0) + usage.cache_creation_input_tokens
  }
  if (usage.cache_read_input_tokens !== undefined) {
    target.cache_read_input_tokens =
      (target.cache_read_input_tokens ?? 0) + usage.cache_read_input_tokens
  }
}

function cancellationResult(state: EngineState): QueryResult {
  return {
    exit_reason: 'user_cancel',
    usage: state.usage,
    turns: state.turn,
    error: 'Query aborted by user',
  }
}

function recordCancellation(state: EngineState): void {
  appendJournal({
    kind: 'user',
    digest: state.inputDigest,
    cancel: true,
  })
}

/**
 * Creates the Batch 0 QueryState while preserving identity with the live tool context.
 * Prompt/provider setup remains deferred until after the initial abort check.
 */
export async function initQueryState(
  input: string,
  ctx: QueryLoopContext,
  signal?: AbortSignal,
): Promise<EngineState> {
  if (!ctx.sessionId) {
    ctx.sessionId = crypto.randomUUID()
  }
  setSessionId(ctx.sessionId)

  const rules = await loadAllRules()
  ctx.injectedRules = ctx.injectedRules || []
  ctx.recordedRuleOutcomes = ctx.recordedRuleOutcomes || new Set<string>()

  const inputDigest = crypto.createHash('sha256').update(input).digest('hex')
  appendJournal({ kind: 'user', digest: inputDigest, cancel: false })

  ctx.messages = ctx.messages || []
  if (signal) {
    ctx.abortSignal = signal
  }

  return {
    turn: 0,
    messages: ctx.messages,
    usage: { input_tokens: 0, output_tokens: 0 },
    model: getResolvedModel(),
    sessionId: ctx.sessionId,
    abortSignal: ctx.abortSignal,
    repoRoot: ctx.repoRoot,
    injectedRules: ctx.injectedRules,
    recordedRuleOutcomes: ctx.recordedRuleOutcomes,
    tasks: new Map(),
    hooks: {},
    compactConsecutiveFailures: 0,
    compactCircuitOpen: false,
    input,
    inputDigest,
    rules,
  }
}

async function prepareQueryState(
  state: EngineState,
  ctx: QueryLoopContext,
): Promise<ReadyEngineState> {
  state.messages.push({
    role: 'user',
    content: [{ type: 'text', text: state.input }],
  })

  const provider = getProvider()
  const tools = getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
  }))
  const memories = await loadMemories()
  const recalledMemories = await findRelevantMemories(state.input, memories, {
    systemPrompt: buildStaticPrompt(),
    signal: ctx.abortSignal,
  })
  const compiledContext = await assembleSessionContext(
    ctx,
    state.model,
    state.usage,
    recalledMemories,
  )
  ctx.firstTurnDynamicSystem = compiledContext.preamble

  state.provider = provider
  state.tools = tools
  state.system = compiledContext.systemStable
  state.dynamicSystem = compiledContext.preamble
  return state as ReadyEngineState
}

/** Phase 1: compact old context when needed and yield the inline compact event. */
export async function* maybeCompact(
  state: ReadyEngineState,
  ctx: QueryLoopContext,
): AsyncGenerator<StreamEvent, 'proceed' | 'restart_loop', undefined> {
  if (
    state.compactCircuitOpen ||
    !shouldCompact(state.messages, state.model, state.contextSnapshot) ||
    selectKeepTail(state.messages) <= 0
  ) {
    return 'proceed'
  }

  const compactStart = performance.now()
  try {
    const compactResult = await compact(state.messages, {
      systemPrompt: state.system,
      signal: ctx.abortSignal,
      snapshot: state.contextSnapshot,
      onForkUsage: (usage) => addUsage(state.usage, usage),
    })
    const replacement = [
      createCompactSummaryMessage(compactResult.summary),
      ...compactResult.messagesKept,
    ]
    state.messages = replacement
    ctx.messages = replacement
    state.contextSnapshot = undefined
    state.compactConsecutiveFailures = 0
    state.compactBoundary = 1
    const durationMs = Math.max(0, Math.round(performance.now() - compactStart))
    dbg('compact', 'Context compacted', {
      preTokens: compactResult.preCompactTokens,
      postTokens: compactResult.postCompactTokens,
      durationMs,
    })
    yield {
      type: 'compact',
      preTokens: compactResult.preCompactTokens,
      postTokens: compactResult.postCompactTokens,
      durationMs,
    }
  } catch (error) {
    const durationMs = Math.max(0, Math.round(performance.now() - compactStart))
    if (error instanceof CompactAbortError) {
      dbg('compact', 'Context compaction cancelled', { durationMs })
      if (ctx.abortSignal?.aborted) return 'restart_loop'
    } else {
      state.compactConsecutiveFailures++
      state.compactCircuitOpen = state.compactConsecutiveFailures >= 3
      const compactError =
        error instanceof CompactError
          ? error
          : new CompactError('Unexpected context compaction failure', { cause: error })
      dbg('compact', 'Context compaction failed; continuing without replacement', {
        error: compactError.message,
        durationMs,
        consecutiveFailures: state.compactConsecutiveFailures,
        circuitOpen: state.compactCircuitOpen,
      })
    }
  }

  return 'proceed'
}

/** Phase 2: return the once-built prompt/tool packet with the current live messages. */
export async function assembleContext(state: ReadyEngineState): Promise<AssembledContext> {
  return {
    system: state.system,
    dynamicSystem: state.dynamicSystem,
    tools: state.tools,
    messages: state.messages,
  }
}

/** Matches provider errors that indicate the context window was exceeded. */
export function isPromptTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /prompt is too long|maximum context length|context_length_exceeded/i.test(message)
}

/** Phase 3: stream one provider turn, update usage/context state, and yield normalized events. */
export async function* streamFromProvider(
  state: ReadyEngineState,
  context: AssembledContext,
  ctx: QueryLoopContext,
): AsyncGenerator<StreamEvent, StreamPhaseResult, undefined> {
  state.turn++
  dbg('query', `Starting turn ${state.turn}/${MAX_TURNS}`)
  appendJournal({ kind: 'turn', turn: state.turn })

  const assistantBlocks: ContentBlock[] = []
  let finalUsage: Usage | null = null
  const messagesAtStreamStart = state.messages.length

  try {
    const stream = state.provider.createMessageStream(context.messages, context.tools, {
      model: state.model,
      maxTokens: 4096,
      signal: ctx.abortSignal || new AbortController().signal,
      system: context.system,
      dynamicSystem: context.dynamicSystem,
    })

    for await (const event of stream) {
      if (ctx.abortSignal?.aborted) {
        recordCancellation(state)
        return { kind: 'exit', result: cancellationResult(state) }
      }

      if (event.type === 'text_delta') {
        yield { type: 'text_delta', text: event.text }
        const lastBlock = assistantBlocks[assistantBlocks.length - 1]
        if (lastBlock?.type === 'text') {
          lastBlock.text += event.text
        } else {
          assistantBlocks.push({ type: 'text', text: event.text })
        }
      } else if (event.type === 'tool_use') {
        yield {
          type: 'tool_use',
          id: event.id,
          name: event.name,
          input: event.input,
        }
        assistantBlocks.push({
          type: 'tool_use',
          id: event.id,
          name: event.name,
          input: event.input,
        })
      } else if (event.type === 'message_end') {
        finalUsage = event.usage
        state.contextSnapshot = {
          tokens: totalTokensFromUsage(event.usage),
          coveredCount: messagesAtStreamStart + 1,
        }
      }
    }
  } catch (error) {
    if (ctx.abortSignal?.aborted) {
      recordCancellation(state)
      return { kind: 'exit', result: cancellationResult(state) }
    }
    dbg('query', 'Fatal error during LLM streaming', error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      kind: 'exit',
      result: {
        exit_reason: isPromptTooLongError(error) ? 'prompt_too_long' : 'fatal_error',
        usage: state.usage,
        turns: state.turn,
        error: errorMessage,
      },
    }
  }

  const usage = finalUsage || { input_tokens: 0, output_tokens: 0 }
  addUsage(state.usage, usage)
  yield { type: 'message_end', usage }
  state.messages.push({ role: 'assistant', content: assistantBlocks })
  return { kind: 'complete', assistantBlocks }
}

/** Phase 32 seam: post-tool-use hooks are intentionally a no-op until hooks land. */
export async function executePostToolUseHooks(state: QueryState): Promise<void> {
  void state
}

/** Phase 4: execute every requested tool serially and append canonical tool results. */
export async function* executeTools(
  state: ReadyEngineState,
  ctx: QueryLoopContext,
  assistantBlocks: ContentBlock[],
): AsyncGenerator<StreamEvent, { restartLoop: boolean }, undefined> {
  const toolUses = assistantBlocks.filter(
    (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
  )

  for (const toolUse of toolUses) {
    if (ctx.abortSignal?.aborted) {
      recordCancellation(state)
      break
    }

    dbg('query', 'tool call detected', { tool: toolUse.name, input: toolUse.input })

    let toolResultContent: string
    let isError = false
    const toolResult = await runTool(toolUse.name, toolUse.input, ctx)

    yield {
      type: 'tool_done',
      id: toolUse.id,
      name: toolUse.name,
      status: toolResult.ok ? 'done' : 'error',
    }

    if (toolResult.ok) {
      toolResultContent =
        typeof toolResult.value === 'string' ? toolResult.value : JSON.stringify(toolResult.value)
    } else {
      isError = true
      toolResultContent = JSON.stringify({ error: toolResult.error })
    }

    const verifyResult = ctx._lastVerifyResultForQuery
    if (verifyResult?.isVerificationRun) {
      ctx._lastVerifyResultForQuery = undefined
      const injectedRulesList = ctx.injectedRules
      const recordedOutcomes = ctx.recordedRuleOutcomes

      if (injectedRulesList && injectedRulesList.length > 0 && recordedOutcomes) {
        const postSigs = verifyResult.fingerprints.map((fingerprint) => fingerprint.fine)

        for (const { rule, fingerprint } of injectedRulesList) {
          if (recordedOutcomes.has(rule.id)) continue

          const stillFailing = postSigs.includes(fingerprint.fine)
          if (!stillFailing) {
            rule.hits++
            rule.alpha++
            rule.last_matched_at = new Date().toISOString()
            recordedOutcomes.add(rule.id)
            dbg('query', `Hit recorded for rule ${rule.id}. New hits count: ${rule.hits}`)
          } else {
            rule.misses++
            rule.beta++
            recordedOutcomes.add(rule.id)
            dbg('query', `Miss recorded for rule ${rule.id}. New misses count: ${rule.misses}`)
          }

          await updateLifecycle(rule, ctx.repoRoot)
          await saveRule(rule)
        }
      }
    }

    const lastFingerprints = ctx._lastFingerprints
    if (lastFingerprints) {
      ctx._lastFingerprints = undefined

      if (toolUse.name === 'Bash' && !ctx.verificationCommand) {
        ctx.verificationCommand = (toolUse.input as { command: string }).command
      }

      const matches = findMatchingRules(lastFingerprints, state.rules)
      if (matches.length > 0) {
        const adviceBlocks = matches.map(formatMatchAdvice).join('\n\n')
        toolResultContent += `\n\n<octo-memory>\n${adviceBlocks}\n</octo-memory>`

        for (const match of matches) {
          ctx.injectedRules?.push({ rule: match.rule, fingerprint: match.fingerprint })
        }
      }
    }

    state.messages.push({
      role: 'tool',
      tool_use_id: toolUse.id,
      content: toolResultContent,
    })

    void isError
  }

  await executePostToolUseHooks(state)
  return { restartLoop: ctx.abortSignal?.aborted === true }
}

/** Returns whether an assistant response has finished without requesting tools. */
export function shouldStop(assistantBlocks: ContentBlock[]): boolean {
  return !assistantBlocks.some((block) => block.type === 'tool_use')
}

/** Phase 32 seam: stop hooks are intentionally a no-op until hooks land. */
export async function executeStopHooks(state: QueryState): Promise<void> {
  void state
}

/** Phase 6: return a terminal result when cumulative billed usage exceeds the configured cap. */
export async function checkBudget(
  state: QueryState,
  ctx: QueryLoopContext,
): Promise<QueryResult | undefined> {
  if (ctx.tokenBudget !== undefined && totalTokensFromUsage(state.usage) > ctx.tokenBudget) {
    return {
      exit_reason: 'budget_exceeded',
      usage: state.usage,
      turns: state.turn,
    }
  }

  return undefined
}

/** Runs the phased agentic query loop. */
export async function* query(
  input: string,
  ctx: QueryLoopContext,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, QueryResult, undefined> {
  const state = await initQueryState(input, ctx, signal)
  let exitReason: ExitReason = 'fatal_error'

  try {
    if (ctx.abortSignal?.aborted) {
      exitReason = 'user_cancel'
      recordCancellation(state)
      return cancellationResult(state)
    }

    const readyState = await prepareQueryState(state, ctx)

    while (readyState.turn < MAX_TURNS) {
      if (ctx.abortSignal?.aborted) {
        exitReason = 'user_cancel'
        recordCancellation(readyState)
        return cancellationResult(readyState)
      }

      const compactAction = yield* maybeCompact(readyState, ctx)
      if (compactAction === 'restart_loop') continue

      const context = await assembleContext(readyState)
      const streamResult = yield* streamFromProvider(readyState, context, ctx)
      if (streamResult.kind === 'exit') {
        exitReason = streamResult.result.exit_reason
        return streamResult.result
      }

      const hasToolUse = streamResult.assistantBlocks.some((block) => block.type === 'tool_use')
      if (hasToolUse) {
        const toolResult = yield* executeTools(readyState, ctx, streamResult.assistantBlocks)
        if (toolResult.restartLoop) continue
      }

      const stop = shouldStop(streamResult.assistantBlocks)
      if (stop) {
        await executeStopHooks(readyState)
        await extractMemories(readyState, ctx)
        const assistantText = streamResult.assistantBlocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        exitReason = 'completed'
        return {
          exit_reason: 'completed',
          usage: readyState.usage,
          turns: readyState.turn,
          final_message: assistantText,
        }
      }

      const budgetResult = await checkBudget(readyState, ctx)
      if (budgetResult) {
        exitReason = 'budget_exceeded'
        return budgetResult
      }
    }

    exitReason = 'max_turns'
    return {
      exit_reason: 'max_turns',
      usage: readyState.usage,
      turns: readyState.turn,
    }
  } finally {
    appendJournal({
      kind: 'session',
      exit_reason: exitReason,
      usage: {
        input_tokens: state.usage.input_tokens,
        output_tokens: state.usage.output_tokens,
      },
      model: getResolvedModel(),
    })
    await flushJournal()

    try {
      if (ctx.sessionId) {
        await runSessionEndEpisodes(ctx.sessionId)
      }
    } catch (error) {
      dbg('query', 'Failed to run session-end episode hook', error)
    }

    try {
      if (ctx.sessionId) {
        await runSessionEndCalibration(ctx.sessionId)
      }
    } catch (error) {
      dbg('query', 'Failed to run session-end calibration hook', error)
    }

    if (process.env.DEBUG === '1' || process.argv.includes('--debug')) {
      try {
        const { readCalibrationRecords, aggregateCalibrationStats } = await import(
          '../memory/calibration/stats.ts'
        )
        const { formatStatsTable } = await import('../memory/calibration/format.ts')
        const records = await readCalibrationRecords()
        const statsList = aggregateCalibrationStats(records)
        const table = formatStatsTable(statsList)
        dbg('calibration', `\n${table}`)
      } catch (error) {
        dbg('query', 'Failed to print debug calibration summary', error)
      }
    }
  }
}

/** Runs one-shot mode while preserving the established stdout format. */
export async function runQuery(userPrompt: string): Promise<void> {
  const ctx: ToolContext = { repoRoot: getRepoRoot() }
  const generator = query(userPrompt, ctx)

  for await (const event of generator) {
    if (event.type === 'text_delta') {
      process.stdout.write(event.text)
    } else if (event.type === 'tool_use') {
      let inputStr = ''
      if (event.input && typeof event.input === 'object') {
        const values = Object.values(event.input)
        if (values.length > 0) inputStr = ` ${values[0]}`
      }
      process.stdout.write(`\n[Tool Call] ${event.name}${inputStr}...\n`)
    } else if (event.type === 'compact') {
      process.stdout.write(
        `\n✻ Context compacted: ${event.preTokens.toLocaleString('en-US')} → ${event.postTokens.toLocaleString('en-US')} tokens\n`,
      )
    }
  }
  process.stdout.write('\n')
}
