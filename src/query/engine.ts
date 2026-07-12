import crypto from 'node:crypto'
import { isActiveConfigTrusted, loadConfig } from '../config/load'
import type { OctonoesisConfig } from '../config/schema'
import { registerBuiltinHooks } from '../hooks/builtins'
import { executeAttachedHooks } from '../hooks/execute'
import { HookRegistry } from '../hooks/registry'
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
import { getProvider, getResolvedModel, setConfiguredModel } from '../providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  ContentBlock,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
  Usage,
} from '../providers'
import type { ResolvedSandboxConfig } from '../sandbox/types'
import { loadSkills } from '../skills/loader'
import { createSessionState, flushSessionStats, formatSessionSummary } from '../state/session'
import { bashTool } from '../tools/Bash'
import { editTool } from '../tools/Edit'
import { globTool } from '../tools/Glob'
import { grepTool } from '../tools/Grep'
import { readTool } from '../tools/Read'
import { SkillTool } from '../tools/SkillTool'
import { todoWriteTool } from '../tools/TodoWrite'
import type { ToolContext } from '../tools/Tool'
import { writeTool } from '../tools/Write'
import { runTool } from '../tools/execute'
import { getAllTools, registerTool } from '../tools/registry'
import { estimateCost } from '../utils/cost'
import { dbg } from '../utils/debug'
import { getRepoRoot } from '../utils/path'
import { zodToJsonSchema } from '../utils/schema'
import type { ContextSnapshot } from '../utils/tokens'
import {
  contextTokensWithEstimation,
  getContextWindowSize,
  totalTokensFromUsage,
} from '../utils/tokens'
import {
  CompactAbortError,
  CompactError,
  compact,
  createCompactSummaryMessage,
  selectKeepTail,
  shouldCompact,
} from './compact'
import type { ExitReason, QueryLoopContext, QueryResultV1, QueryState, SessionState } from './types'

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
  | { type: 'session_state'; sessionState: SessionState; priced: boolean }

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
  emitSessionState: boolean
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

function sessionStateSnapshot(sessionState: SessionState): SessionState {
  return { ...sessionState, usage: { ...sessionState.usage } }
}

function currentSessionStateEvent(
  state: EngineState,
  ctx: QueryLoopContext,
): Extract<StreamEvent, { type: 'session_state' }> {
  const sessionState = ctx.sessionState
  if (!sessionState) throw new Error('Session state was not initialized')

  const pricing = estimateCost(sessionState.usage, sessionState.model)
  sessionState.costUsd = pricing.costUsd
  sessionState.contextUtilization =
    contextTokensWithEstimation(state.messages, state.contextSnapshot) /
    getContextWindowSize(state.model)
  return {
    type: 'session_state',
    sessionState: sessionStateSnapshot(sessionState),
    priced: pricing.priced,
  }
}

function recordSessionTurn(
  state: EngineState,
  ctx: QueryLoopContext,
  usage: Usage,
): Extract<StreamEvent, { type: 'session_state' }> {
  const sessionState = ctx.sessionState
  if (!sessionState) throw new Error('Session state was not initialized')
  addUsage(sessionState.usage, usage)
  sessionState.turns++
  return currentSessionStateEvent(state, ctx)
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
  const model = getResolvedModel()
  const emitSessionState = ctx.sessionState !== undefined
  ctx.sessionState ??= createSessionState(ctx.sessionId, model)

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
    model,
    sessionId: ctx.sessionId,
    abortSignal: ctx.abortSignal,
    repoRoot: ctx.repoRoot,
    injectedRules: ctx.injectedRules,
    recordedRuleOutcomes: ctx.recordedRuleOutcomes,
    tasks: new Map(),
    hooks: ctx.hooks ?? new HookRegistry(),
    compactConsecutiveFailures: 0,
    compactCircuitOpen: false,
    emitSessionState,
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
  const skills = await loadSkills(ctx.repoRoot)
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
    skills,
  )
  if (skills.length > 0) {
    registerTool(
      new SkillTool(skills, {
        systemPrompt: compiledContext.systemStable,
        onForkUsage: (usage) => {
          addUsage(state.usage, usage)
          if (ctx.sessionState) addUsage(ctx.sessionState.usage, usage)
        },
      }),
    )
  }
  const tools = getAllTools()
    .filter((tool) => tool.name !== 'Skill' || skills.length > 0)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
    }))
  ctx.firstTurnDynamicSystem = compiledContext.preamble

  state.provider = provider
  state.tools = tools
  state.system = compiledContext.systemStable
  state.dynamicSystem = compiledContext.preamble
  await executeAttachedHooks(ctx, { event: 'session_start', sessionId: ctx.sessionId }, state)
  return state as ReadyEngineState
}

async function initializeHooks(ctx: QueryLoopContext): Promise<void> {
  const hookRegistry = new HookRegistry()
  registerBuiltinHooks(hookRegistry)
  ctx.hooks = hookRegistry
  const config = ctx.config ?? (await loadConfig(ctx.repoRoot))
  if (!(await isActiveConfigTrusted(ctx.repoRoot, config))) return
  for (const hook of config.hooks) {
    hookRegistry.register({
      event: hook.event,
      ...(hook.toolPattern ? { toolPattern: hook.toolPattern } : {}),
      handler: { type: 'shell', command: hook.command },
    })
  }
}

/** Phase 1: compact old context when needed and yield the inline compact event. */
export async function* maybeCompact(
  state: ReadyEngineState,
  ctx: QueryLoopContext,
): AsyncGenerator<StreamEvent, 'proceed' | 'restart_loop', undefined> {
  const cooldownTurns = ctx.config?.compaction.cooldownTurns ?? 0
  const coolingDown =
    state.lastCompactTurn !== undefined && state.turn - state.lastCompactTurn <= cooldownTurns
  if (
    state.compactCircuitOpen ||
    coolingDown ||
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
      onForkUsage: (usage) => {
        addUsage(state.usage, usage)
        if (ctx.sessionState) addUsage(ctx.sessionState.usage, usage)
      },
      minShrinkPercent: ctx.config?.compaction.minShrinkPercent ?? 0,
    })
    const replacement = [
      compactResult.pinnedHead,
      createCompactSummaryMessage(compactResult.summary),
      ...compactResult.messagesKept,
    ]
    state.messages = replacement
    ctx.messages = replacement
    state.contextSnapshot = undefined
    state.compactConsecutiveFailures = 0
    state.compactBoundary = 2
    state.lastCompactTurn = state.turn
    const durationMs = Math.max(0, Math.round(performance.now() - compactStart))
    dbg('compact', 'Context compacted', {
      preTokens: compactResult.preCompactTokens,
      postTokens: compactResult.postCompactTokens,
      durationMs,
    })
    if (ctx.sessionState) ctx.sessionState.compactCount++
    await executeAttachedHooks(
      ctx,
      {
        event: 'compact',
        outcome: {
          preTokens: compactResult.preCompactTokens,
          postTokens: compactResult.postCompactTokens,
          durationMs,
        },
        sessionId: ctx.sessionId,
      },
      state,
    )
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
  dbg('query', `Starting turn ${state.turn}/${ctx.config?.maxTurns ?? 50}`)
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
  const sessionStateEvent = recordSessionTurn(state, ctx, usage)
  if (state.emitSessionState) yield sessionStateEvent
  state.messages.push({ role: 'assistant', content: assistantBlocks })
  return { kind: 'complete', assistantBlocks }
}

/** Executes post-tool-use hooks after the canonical result has been appended. */
export async function executePostToolUseHooks(
  state: QueryState,
  ctx: QueryLoopContext,
  tool: string,
  input: unknown,
  outcome: unknown,
): Promise<void> {
  await executeAttachedHooks(
    ctx,
    { event: 'post_tool_use', tool, input, outcome, sessionId: ctx.sessionId },
    state,
  )
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
      content: isError
        ? [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: toolResultContent,
              is_error: true,
            },
            { type: 'text', text: toolResultContent },
          ]
        : toolResultContent,
    })

    await executePostToolUseHooks(state, ctx, toolUse.name, toolUse.input, toolResult)
  }

  return { restartLoop: ctx.abortSignal?.aborted === true }
}

/** Returns whether an assistant response has finished without requesting tools. */
export function shouldStop(assistantBlocks: ContentBlock[]): boolean {
  return !assistantBlocks.some((block) => block.type === 'tool_use')
}

/** Executes clean-stop hooks before the completed QueryResult is returned. */
export async function executeStopHooks(state: QueryState, ctx: QueryLoopContext): Promise<void> {
  await executeAttachedHooks(ctx, { event: 'stop', sessionId: ctx.sessionId }, state)
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
  ctx.config ??= await loadConfig(ctx.repoRoot)
  setConfiguredModel(ctx.config.model)
  await initializeHooks(ctx)
  const state = await initQueryState(input, ctx, signal)
  let exitReason: ExitReason = 'fatal_error'

  try {
    if (ctx.abortSignal?.aborted) {
      exitReason = 'user_cancel'
      recordCancellation(state)
      return cancellationResult(state)
    }

    const readyState = await prepareQueryState(state, ctx)

    while (readyState.turn < ctx.config.maxTurns) {
      if (ctx.abortSignal?.aborted) {
        exitReason = 'user_cancel'
        recordCancellation(readyState)
        return cancellationResult(readyState)
      }

      const compactCountBefore = ctx.sessionState?.compactCount ?? 0
      const compactAction = yield* maybeCompact(readyState, ctx)
      if (
        readyState.emitSessionState &&
        ctx.sessionState &&
        ctx.sessionState.compactCount > compactCountBefore
      ) {
        yield currentSessionStateEvent(readyState, ctx)
      }
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
        await executeStopHooks(readyState, ctx)
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
    await executeAttachedHooks(
      ctx,
      { event: 'session_end', outcome: { exitReason }, sessionId: ctx.sessionId },
      state,
    )
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
export async function runQuery(
  userPrompt: string,
  sandbox?: ResolvedSandboxConfig,
  config?: OctonoesisConfig,
): Promise<void> {
  const sessionId = crypto.randomUUID()
  if (config) setConfiguredModel(config.model)
  const model = getResolvedModel()
  const ctx: ToolContext = {
    repoRoot: getRepoRoot(),
    sessionId,
    sessionState: createSessionState(sessionId, model),
    sandbox,
    config,
  }
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
  await flushSessionStats()
  const priced = ctx.sessionState
    ? estimateCost(ctx.sessionState.usage, ctx.sessionState.model).priced
    : false
  process.stdout.write(
    ctx.sessionState ? `\n${formatSessionSummary(ctx.sessionState, priced)}\n` : '\n',
  )
}
