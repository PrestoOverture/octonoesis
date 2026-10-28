import crypto from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { isActiveConfigTrusted, loadConfig } from '../config/load'
import type { OctonoesisConfig } from '../config/schema'
import { assignArm, filterRulesForArm, recordAssignment } from '../experiments/assignment'
import { getActiveExperiment, readExperiments } from '../experiments/registry'
import { registerBuiltinHooks } from '../hooks/builtins'
import { executeAttachedHooks } from '../hooks/execute'
import { HookRegistry } from '../hooks/registry'
import { cleanupMcp, initializeMcp } from '../mcp/registry'
import { findRelevantMemories } from '../memory/auto/recall'
import { loadMemories } from '../memory/auto/store'
import { formatMemoryUnavailableNotice, isMemoryDisabled } from '../memory/availability'
import { runSessionEndCalibration } from '../memory/calibration/hook'
import { runSessionEndEpisodes } from '../memory/episodes/hook'
import {
  appendJournal,
  flushJournal,
  formatJournalFailureNotice,
  setSessionId,
} from '../memory/journal'
import { type AutoDistillResult, runSessionEndAutoDistill } from '../memory/rules/autoDistill'
import { updateLifecycle } from '../memory/rules/lifecycle'
import { findMatchingRules, formatMatchAdvice } from '../memory/rules/match'
import { getRulesDir, loadAllRules, loadRule, saveRule } from '../memory/rules/store'
import { type RuleFile, calculateConfidence } from '../memory/rules/types'
import { assembleSessionContext } from '../prompts/context'
import { buildStaticPrompt } from '../prompts/static'
import { getProvider, getResolvedModel, setConfiguredModel } from '../providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  ContentBlock,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
  StopReason,
  Usage,
} from '../providers'
import type { ResolvedSandboxConfig } from '../sandbox/types'
import { loadSkills } from '../skills/loader'
import { createSessionState, flushSessionStats, formatSessionSummary } from '../state/session'
import { saveSession } from '../state/sessionStore'
import { cleanupTasks, drainTaskNotifications } from '../tasks/framework'
import { AgentTool } from '../tools/AgentTool'
import { bashTool } from '../tools/Bash'
import { editTool } from '../tools/Edit'
import { globTool } from '../tools/Glob'
import { grepTool } from '../tools/Grep'
import { MCPTool } from '../tools/MCPTool'
import { readTool } from '../tools/Read'
import { SendMessageTool } from '../tools/SendMessageTool'
import { SkillTool } from '../tools/SkillTool'
import { todoWriteTool } from '../tools/TodoWrite'
import type { ToolContext } from '../tools/Tool'
import { webFetchTool } from '../tools/WebFetch'
import { writeTool } from '../tools/Write'
import { runTool, safeParseToolInput } from '../tools/execute'
import { getAllTools, registerTool, unregisterTool } from '../tools/registry'
import { createMarkdownStream } from '../ui/markdown'
import { estimateCost } from '../utils/cost'
import { dbg } from '../utils/debug'
import { isRetriableError } from '../utils/errors'
import {
  LockTimeoutError,
  RULES_LOCK_OPTIONS,
  warnLockTimeout,
  withFileLock,
} from '../utils/fileLock'
import { getRepoRoot } from '../utils/path'
import { zodToJsonSchema } from '../utils/schema'
import type { ContextSnapshot } from '../utils/tokens'
import {
  contextTokensWithEstimation,
  estimateMessagesTokens,
  getContextWindowSize,
  totalTokensFromUsage,
} from '../utils/tokens'
import { BackgroundCompaction } from './backgroundCompact'
import {
  CompactAbortError,
  CompactError,
  type CompactResult,
  compact,
  createCompactSummaryMessage,
  isCompactionDisabled,
  selectKeepTail,
  shouldCompact,
} from './compact'
import { clearOldToolResults } from './toolResultClearing'
import { summarizeToolResult } from './toolSummary'
import type { ExitReason, QueryLoopContext, QueryResultV1, QueryState, SessionState } from './types'

registerTool(readTool)
registerTool(globTool)
registerTool(bashTool)
registerTool(writeTool)
registerTool(editTool)
registerTool(grepTool)
registerTool(todoWriteTool)
registerTool(webFetchTool)

const sessionAgentTools = new WeakMap<QueryLoopContext, [AgentTool, SendMessageTool]>()

export type LearningEvent =
  | {
      type: 'rule_recall'
      trigger: 'session_start' | 'failure'
      toolUseId?: string
      rules: { id: string; confidence: number }[]
    }
  | { type: 'rule_outcome'; id: string; hit: boolean; before: number; after: number }
  | ({ type: 'rules_learned' } & AutoDistillResult)

export type StreamEvent =
  | LearningEvent
  | ProviderStreamEvent
  | { type: 'task_notice'; text: string }
  | { type: 'stream_retry'; attempt: number; reason: string }
  | { type: 'tool_done'; id: string; name: string; status: 'done' | 'error'; summary?: string }
  | { type: 'compact'; preTokens: number; postTokens: number; durationMs: number }
  | { type: 'session_state'; sessionState: SessionState; priced: boolean }

export type QueryResult = QueryResultV1

const ONE_SHOT_FAILURE_REASONS = new Set<ExitReason>([
  'fatal_error',
  'prompt_too_long',
  'budget_exceeded',
])

/**
 * Formats a non-successful query result for CLI and TUI presentation.
 *
 * @param result - Query execution result to format
 * @returns Formatted failure message string, or undefined if the query succeeded or was cancelled
 */
export function formatQueryFailure(result: QueryResult): string | undefined {
  if (result.exit_reason === 'completed' || result.exit_reason === 'user_cancel') return undefined
  const detail =
    result.error ??
    (result.exit_reason === 'budget_exceeded'
      ? 'Token budget exceeded.'
      : result.exit_reason === 'max_turns'
        ? 'Maximum query turns reached.'
        : 'The query could not be completed.')
  return `Query failed (${result.exit_reason}): ${detail}`
}

export type EngineState = QueryState & {
  input: string
  inputDigest: string
  rules: RuleFile[]
  sessionStartRuleIds?: string[]
  pendingCompaction?: BackgroundCompaction
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

/**
 * Prompt, tool, and conversational context compiled for a query turn.
 */
export interface AssembledContext {
  system: string
  dynamicSystem: string
  tools: CanonicalTool[]
  messages: CanonicalMessage[]
}

type StreamPhaseResult =
  | {
      kind: 'complete'
      assistantBlocks: ContentBlock[]
      stopReason: StopReason
      recoveryNote?: string
    }
  | { kind: 'exit'; result: QueryResult }

/**
 * Accumulates token usage metrics into a target usage object.
 *
 * @param target - Destination usage object to mutate
 * @param usage - Source token counts to add
 */
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

/**
 * Creates a shallow copy of session state with cloned usage metrics.
 *
 * @param sessionState - Active session state
 * @returns Cloned snapshot of the session state
 */
function sessionStateSnapshot(sessionState: SessionState): SessionState {
  return { ...sessionState, usage: { ...sessionState.usage } }
}

/**
 * Constructs a session state stream event with updated cost and context utilization.
 *
 * @param state - Current engine state
 * @param ctx - Query loop context containing session state
 * @returns Stream event containing the updated session state
 * @throws If session state is not initialized in context
 */
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

/**
 * Records turn metrics, updating session token usage, turn count, and pricing.
 *
 * @param state - Current engine state
 * @param ctx - Query loop context
 * @param usage - Turn token usage to accumulate
 * @returns Stream event with the updated session state
 * @throws If session state is not initialized in context
 */
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

/**
 * Constructs a cancellation query result when query execution is aborted by user.
 *
 * @param state - Engine state at time of cancellation
 * @returns QueryResult representing user cancellation
 */
function cancellationResult(state: EngineState): QueryResult {
  return {
    exit_reason: 'user_cancel',
    usage: state.usage,
    turns: state.turn,
    error: 'Query aborted by user',
  }
}

/**
 * Logs a cancellation record to the memory journal.
 *
 * @param state - Engine state containing input digest
 */
function recordCancellation(state: EngineState): void {
  appendJournal({
    kind: 'user',
    digest: state.inputDigest,
    cancel: true,
  })
}

/**
 * Creates the initial EngineState while preserving identity with the live tool context.
 *
 * Sets up session identity, loads memory rules and experiment arms, and logs user prompt receipt.
 *
 * @param input - User prompt string
 * @param ctx - Query loop context
 * @param signal - Optional abort signal for cancellation
 * @returns Promise resolving to the initialized engine state
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

  let rules = isMemoryDisabled() ? [] : await loadAllRules()
  ctx.injectedRules = ctx.injectedRules || []
  ctx.recordedRuleOutcomes = ctx.recordedRuleOutcomes || new Set<string>()

  if (!isMemoryDisabled()) {
    const sessionId = ctx.sessionId
    try {
      if (ctx.experimentArm === undefined) {
        // First resolution this session: pick the active experiment (if any), assign this
        // session's arm, and record the assignment before caching — a failure anywhere in
        // here leaves ctx.experimentArm unset so the next query() call retries cleanly.
        const activeExperiment = await getActiveExperiment()
        if (activeExperiment) {
          const arm = assignArm(sessionId, activeExperiment)
          await recordAssignment({
            session_id: sessionId,
            experiment_id: activeExperiment.id,
            arm,
          })
          ctx.experimentArm = { experimentId: activeExperiment.id, arm }
          rules = filterRulesForArm(rules, activeExperiment, arm)
        } else {
          ctx.experimentArm = null
        }
      } else if (ctx.experimentArm) {
        // Already resolved earlier this session: reuse the cached arm (never recompute or
        // re-record) but re-filter against the freshly-loaded rule pool.
        const { experimentId, arm } = ctx.experimentArm
        const experiment = (await readExperiments()).find((entry) => entry.id === experimentId)
        if (experiment) {
          rules = filterRulesForArm(rules, experiment, arm)
        }
      }
    } catch (error) {
      dbg('query', 'Failed to resolve experiment arm assignment; using unfiltered rule pool', error)
    }
  }

  const inputDigest = crypto.createHash('sha256').update(input).digest('hex')
  appendJournal({ kind: 'user', digest: inputDigest, cancel: false })

  ctx.messages = ctx.messages || []
  if (signal) {
    ctx.abortSignal = signal
  }

  const tasks = ctx.tasks ?? new Map()
  ctx.tasks = tasks
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
    tasks,
    hooks: ctx.hooks ?? new HookRegistry(),
    compactConsecutiveFailures: 0,
    compactCircuitOpen: false,
    emitSessionState,
    input,
    inputDigest,
    rules,
  }
}

/**
 * Prepares the engine state for execution by draining tasks, assembling prompts, and loading tools.
 *
 * Appends the user message, recalls relevant memories, loads skills and MCP tools, registers
 * session agent tools, sets up prompt contexts, and triggers the `session_start` hook.
 *
 * @param state - Initialized engine state
 * @param ctx - Query loop context
 * @returns Promise resolving to the fully prepared engine state ready for execution turns
 */
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
    state.rules,
  )
  state.sessionStartRuleIds = compiledContext.sessionStartRuleIds
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
  } else {
    // No skills this query: drop any SkillTool registered by an earlier query on this session
    // so its stale skill map doesn't linger in the global registry (the provider tools-list
    // filter below already hides it, but getTool('Skill') would still resolve it).
    unregisterTool('Skill')
  }
  const agentTool = new AgentTool({
    systemPrompt: compiledContext.systemStable,
    model: state.model,
    onForkUsage: (usage) => {
      addUsage(state.usage, usage)
      if (ctx.sessionState) addUsage(ctx.sessionState.usage, usage)
    },
  })
  const sendMessageTool = new SendMessageTool()
  registerTool(agentTool)
  registerTool(sendMessageTool)
  sessionAgentTools.set(ctx, [agentTool, sendMessageTool])
  await initializeMcp(ctx)
  const tools = getAllTools()
    .filter((tool) => tool.name !== 'Skill' || skills.length > 0)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema:
        tool instanceof MCPTool
          ? tool.providerInputSchema
          : (zodToJsonSchema(tool.inputSchema) as Record<string, unknown>),
    }))
  ctx.firstTurnDynamicSystem = compiledContext.preamble

  state.provider = provider
  state.tools = tools
  state.system = compiledContext.systemStable
  state.dynamicSystem = compiledContext.preamble
  await executeAttachedHooks(ctx, { event: 'session_start', sessionId: ctx.sessionId }, state)
  return state as ReadyEngineState
}

/**
 * Drains pending background task notifications and appends them as synthetic user messages.
 *
 * @param state - Target state containing message history
 * @param ctx - Query loop context managing active background tasks
 * @yields A display notification for each synthetic message appended
 */
async function* injectTaskNotifications(
  state: Pick<QueryState, 'messages'>,
  ctx: QueryLoopContext,
): AsyncGenerator<StreamEvent> {
  for (const notification of await drainTaskNotifications(ctx)) {
    state.messages.push({ role: 'user', content: notification })
    yield { type: 'task_notice', text: notification }
  }
}

/**
 * Initializes the hook registry, registering built-in hooks and configured project hooks.
 *
 * @param ctx - Query loop context to attach hooks to
 * @returns Promise resolving when hooks have been registered
 */
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

/**
 * Phase 1: compacts old conversation context when needed and yields inline compact event.
 *
 * Tracks failure circuit breaking and cooldown turns between compaction attempts.
 *
 * @param state - Ready engine state
 * @param ctx - Query loop context
 * @returns AsyncGenerator yielding compact events and returning loop direction ('proceed' or 'restart_loop')
 */
export async function* maybeCompact(
  state: ReadyEngineState,
  ctx: QueryLoopContext,
): AsyncGenerator<StreamEvent, 'proceed' | 'restart_loop', undefined> {
  if (isCompactionDisabled()) {
    await state.pendingCompaction?.cancel()
    state.pendingCompaction = undefined
    return 'proceed'
  }
  const cleared = clearOldToolResults(state.messages, state.model, {
    ...ctx.config?.compaction.toolResultClearing,
    enabled: state.pendingCompaction ? false : ctx.config?.compaction.toolResultClearing?.enabled,
    snapshot: state.contextSnapshot,
  })
  if (cleared.clearedCount > 0) {
    state.messages = cleared.messages
    ctx.messages = cleared.messages
    state.contextSnapshot = undefined
    dbg('compact', 'Cleared old reproducible tool results', { count: cleared.clearedCount })
  }
  const cooldownTurns = ctx.config?.compaction.cooldownTurns ?? 0
  const coolingDown =
    state.lastCompactTurn !== undefined && state.turn - state.lastCompactTurn <= cooldownTurns
  const backgroundEnabled = ctx.config?.compaction.background?.enabled ?? true
  const thresholdRatio = backgroundEnabled
    ? (ctx.config?.compaction.background?.triggerRatio ?? 0.75)
    : 1
  const hardThreshold = shouldCompact(state.messages, state.model, state.contextSnapshot)
  if (
    state.compactCircuitOpen ||
    coolingDown ||
    (!state.pendingCompaction &&
      !shouldCompact(state.messages, state.model, state.contextSnapshot, thresholdRatio)) ||
    selectKeepTail(state.messages) <= 0
  ) {
    return 'proceed'
  }

  let compactStart = state.pendingCompaction?.startedAt ?? performance.now()
  try {
    const opts = {
      systemPrompt: state.system,
      recordEvent: false,
      preserveTaskState: true,
      signal: ctx.abortSignal,
      snapshot: state.contextSnapshot,
      onForkUsage: (usage: Usage) => {
        addUsage(state.usage, usage)
        if (ctx.sessionState) addUsage(ctx.sessionState.usage, usage)
      },
      minShrinkPercent: ctx.config?.compaction.minShrinkPercent ?? 0,
    }
    let compactResult: CompactResult
    let replacement: CanonicalMessage[]
    if (backgroundEnabled || state.pendingCompaction) {
      state.pendingCompaction ??= new BackgroundCompaction(state.messages, opts)
      const pending = state.pendingCompaction
      compactStart = pending.startedAt
      const outcome = await pending.poll(hardThreshold)
      if (!outcome) return 'proceed'
      state.pendingCompaction = undefined
      if ('error' in outcome) throw outcome.error
      const candidate = pending.replacement(state.messages, outcome.result)
      if (!candidate) {
        dbg('compact', 'Discarded stale background summary; live prefix changed')
        return 'proceed'
      }
      replacement = candidate
      compactResult = {
        ...outcome.result,
        preCompactTokens: contextTokensWithEstimation(state.messages, state.contextSnapshot),
        postCompactTokens: estimateMessagesTokens(candidate),
      }
      if (compactResult.postCompactTokens >= compactResult.preCompactTokens)
        throw new CompactError('Background compaction did not reduce current context')
      if (
        ((compactResult.preCompactTokens - compactResult.postCompactTokens) /
          compactResult.preCompactTokens) *
          100 <
        opts.minShrinkPercent
      )
        throw new CompactError(
          'Background compaction fell below the configured minimum shrink percentage',
        )
    } else {
      compactResult = await compact(state.messages, opts)
      replacement = [
        compactResult.pinnedHead,
        createCompactSummaryMessage(compactResult.summary),
        ...compactResult.messagesKept,
      ]
    }
    state.messages = replacement
    ctx.messages = replacement
    appendJournal({
      kind: 'compact',
      pre_tokens: compactResult.preCompactTokens,
      post_tokens: compactResult.postCompactTokens,
      summary_length: compactResult.summary.length,
    })
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

/**
 * Phase 2: packages the once-built prompt/tool configuration with current live messages.
 *
 * @param state - Ready engine state
 * @returns Promise resolving to the assembled context packet
 */
export async function assembleContext(state: ReadyEngineState): Promise<AssembledContext> {
  return {
    system: state.system,
    dynamicSystem: state.dynamicSystem,
    tools: state.tools,
    messages: state.messages,
  }
}

/**
 * Evaluates whether an error indicates that the LLM context window limit was exceeded.
 *
 * @param error - Error object or string to check
 * @returns True if the error matches known prompt-too-long message patterns, false otherwise
 */
export function isPromptTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /prompt is too long|maximum context length|context_length_exceeded/i.test(message)
}

/**
 * Phase 3: streams one provider turn, accumulates token usage, and yields normalized stream events.
 *
 * Handles abort cancellation mid-stream, detects context length errors, and updates session state.
 *
 * @param state - Ready engine state
 * @param context - Assembled prompt context
 * @param ctx - Query loop context
 * @returns AsyncGenerator yielding StreamEvents and returning StreamPhaseResult
 */
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
  let stopReason: StopReason = 'other'
  let lastToolUseId: string | undefined
  const droppedCalls: { id: string; name: string; reason: 'invalid_arguments' | 'max_tokens' }[] =
    []
  const maxOutputTokens = ctx.config?.maxOutputTokens ?? 16384
  const messagesAtStreamStart = state.messages.length

  try {
    let attempt = 0
    while (true) {
      assistantBlocks.length = 0
      finalUsage = null
      stopReason = 'other'
      lastToolUseId = undefined
      droppedCalls.length = 0
      let receivedEvent = false
      try {
        const stream = state.provider.createMessageStream(context.messages, context.tools, {
          model: state.model,
          maxTokens: maxOutputTokens,
          signal: ctx.abortSignal || new AbortController().signal,
          system: context.system,
          dynamicSystem: context.dynamicSystem,
        })

        for await (const event of stream) {
          receivedEvent = true
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
            lastToolUseId = event.id
            yield event
            assistantBlocks.push({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: event.input,
            })
          } else if (event.type === 'message_end') {
            finalUsage = event.usage
            stopReason = event.stopReason
            lastToolUseId = event.lastToolUseId ?? lastToolUseId
            for (const call of event.invalidToolCalls ?? []) {
              droppedCalls.push({ ...call, reason: 'invalid_arguments' })
            }
          }
        }
        break
      } catch (error) {
        if (
          ctx.abortSignal?.aborted ||
          !receivedEvent ||
          !isRetriableError(error) ||
          attempt >= 2
        ) {
          throw error
        }
        attempt++
        const reason = error instanceof Error ? error.message : String(error)
        yield { type: 'stream_retry', attempt, reason }
        await delay(500 * 2 ** (attempt - 1), undefined, { signal: ctx.abortSignal })
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

  if (finalUsage) {
    state.contextSnapshot = {
      tokens: totalTokensFromUsage(finalUsage),
      coveredCount: messagesAtStreamStart + 1,
    }
  }
  const usage = finalUsage || { input_tokens: 0, output_tokens: 0 }
  if (stopReason === 'max_tokens' && lastToolUseId !== undefined) {
    const lastToolIndex = assistantBlocks.findIndex(
      (block) => block.type === 'tool_use' && block.id === lastToolUseId,
    )
    const lastTool = assistantBlocks[lastToolIndex]
    if (lastTool?.type === 'tool_use') {
      assistantBlocks.splice(lastToolIndex, 1)
      droppedCalls.push({ id: lastTool.id, name: lastTool.name, reason: 'max_tokens' })
      yield {
        type: 'tool_done',
        id: lastTool.id,
        name: lastTool.name,
        status: 'error',
        summary: 'output truncated; not executed',
      }
    }
  }
  let recoveryNote: string | undefined
  if (stopReason === 'max_tokens' || droppedCalls.length > 0) {
    const dropped = droppedCalls
      .map(
        ({ id, name, reason }) =>
          `Tool call ${name} (${id}) was dropped and NOT executed${reason === 'invalid_arguments' ? ' because its arguments failed JSON.parse' : ''}.`,
      )
      .join(' ')
    recoveryNote = [
      stopReason === 'max_tokens' ? `Your output was cut at ${maxOutputTokens} tokens.` : '',
      dropped,
      droppedCalls.length > 0
        ? 'Split large content: Write a skeleton, then Edit in chunks. Retry dropped work with complete JSON arguments.'
        : 'If you were producing file content, do NOT continue it as text — file content belongs only in tool calls: Write a skeleton or the first chunk, then add the rest with Edit in chunks small enough to fit in one response. Otherwise continue exactly where you stopped.',
    ]
      .filter(Boolean)
      .join(' ')
  }
  if (stopReason === 'max_tokens') {
    appendJournal({
      kind: 'truncation',
      turn: state.turn,
      max_output_tokens: maxOutputTokens,
      output_tokens: usage.output_tokens,
      dropped_tool_calls: droppedCalls,
    })
  }
  addUsage(state.usage, usage)
  yield { type: 'message_end', usage, stopReason }
  const sessionStateEvent = recordSessionTurn(state, ctx, usage)
  if (state.emitSessionState) yield sessionStateEvent
  if (assistantBlocks.length > 0) {
    state.messages.push({ role: 'assistant', content: assistantBlocks })
  }
  return { kind: 'complete', assistantBlocks, stopReason, recoveryNote }
}

/**
 * Executes post-tool-use hooks after the canonical tool result has been recorded.
 *
 * @param state - Active query state
 * @param ctx - Query loop context
 * @param tool - Executed tool name
 * @param input - Invocation arguments passed to the tool
 * @param outcome - Tool execution result or error
 * @returns Promise resolving when all registered post_tool_use hooks have completed
 */
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

/**
 * Phase 4: executes requested tool calls sequentially and appends canonical tool results.
 *
 * Checks cancellation between tool executions, verifies rule outcomes when verification runs
 * complete, injects memory advice on new error fingerprints, and triggers post-tool hooks.
 *
 * @param state - Ready engine state
 * @param ctx - Query loop context
 * @param assistantBlocks - Assistant message blocks containing tool use requests
 * @returns AsyncGenerator yielding tool execution events and returning loop restart status
 */
export async function* executeTools(
  state: ReadyEngineState,
  ctx: QueryLoopContext,
  assistantBlocks: ContentBlock[],
): AsyncGenerator<StreamEvent, { restartLoop: boolean }, undefined> {
  const toolUses = assistantBlocks.filter(
    (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
  )

  const { prepareToolExecution } = await import('../tools/execute')
  type PreparedTool = Awaited<ReturnType<typeof prepareToolExecution>>
  const pending = new Map<number, PreparedTool>()
  let nextTool = 0
  const canBatch = (call: (typeof toolUses)[number]): boolean => {
    try {
      const tool = getAllTools().find((tool) => tool.name === call.name)
      const input = tool ? safeParseToolInput(tool, call.input) : undefined
      return (
        tool !== undefined &&
        input?.success === true &&
        tool.isConcurrencySafe(input.data) &&
        tool.isReadOnly(input.data)
      )
    } catch {
      return false
    }
  }

  for (const [toolIndex, toolUse] of toolUses.entries()) {
    if (ctx.abortSignal?.aborted && !pending.has(toolIndex)) {
      recordCancellation(state)
      for (const cancelledToolUse of toolUses.slice(toolIndex)) {
        const cancellationMessage = 'Tool execution cancelled by user.'
        state.messages.push({
          role: 'tool',
          tool_use_id: cancelledToolUse.id,
          content: [
            {
              type: 'tool_result',
              tool_use_id: cancelledToolUse.id,
              content: cancellationMessage,
              is_error: true,
            },
            { type: 'text', text: cancellationMessage },
          ],
        })
        const display = summarizeToolResult(cancelledToolUse.name, cancelledToolUse.input, {
          ok: false,
          content: cancellationMessage,
        })
        yield {
          type: 'tool_done',
          id: cancelledToolUse.id,
          name: cancelledToolUse.name,
          status: display.failed ? 'error' : 'done',
          summary: display.summary,
        }
      }
      break
    }

    // Prepare in call order, starting at most ten safe read-only calls. A barrier
    // remains suspended until all preceding results and post-tool hooks commit.
    if (!pending.has(toolIndex)) {
      while (nextTool < toolUses.length && pending.size < 10 && !ctx.abortSignal?.aborted) {
        const next = toolUses[nextTool]
        if (!next || !canBatch(next)) break
        const prepared = await prepareToolExecution(next.name, next.input, ctx)
        pending.set(nextTool++, prepared)
        if (!prepared.concurrencySafe) break
        prepared.start()
      }
    }

    dbg('query', 'tool call detected', { tool: toolUse.name, input: toolUse.input })

    let toolResultContent: string
    let isError = false
    const prepared = pending.get(toolIndex)
    const toolResult = prepared
      ? await prepared.finish()
      : await runTool(toolUse.name, toolUse.input, ctx)
    pending.delete(toolIndex)
    if (!prepared) nextTool = toolIndex + 1

    if (toolResult.ok) {
      toolResultContent =
        typeof toolResult.value === 'string' ? toolResult.value : JSON.stringify(toolResult.value)
    } else {
      isError = true
      toolResultContent = JSON.stringify({ error: toolResult.error })
    }

    const display = summarizeToolResult(toolUse.name, toolUse.input, {
      ok: toolResult.ok,
      content: toolResultContent,
    })
    yield {
      type: 'tool_done',
      id: toolUse.id,
      name: toolUse.name,
      status: display.failed ? 'error' : 'done',
      summary: display.summary,
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

          recordedOutcomes.add(rule.id)
          try {
            const outcome = await recordRuleOutcome(
              rule.id,
              postSigs.includes(fingerprint.fine),
              ctx.repoRoot,
            )
            if (outcome && !isMemoryDisabled())
              yield { type: 'rule_outcome', id: rule.id, ...outcome }
          } catch (error) {
            dbg('query', 'Failed to record rule outcome', error)
          }
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
        try {
          if (!isMemoryDisabled())
            yield {
              type: 'rule_recall',
              trigger: 'failure',
              toolUseId: toolUse.id,
              rules: matches.map(({ rule }) => ({
                id: rule.id,
                confidence: calculateConfidence(rule.alpha, rule.beta),
              })),
            }
        } catch (error) {
          dbg('query', 'Failed to display recalled rules', error)
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

/**
 * Evaluates whether an assistant response has concluded without requesting any further tool calls.
 *
 * @param assistantBlocks - Content blocks emitted by the assistant
 * @returns True if no tool use blocks are present, false otherwise
 */
export function shouldStop(assistantBlocks: ContentBlock[]): boolean {
  return !assistantBlocks.some((block) => block.type === 'tool_use')
}

/**
 * Executes clean-stop hooks before the completed QueryResult is returned.
 *
 * @param state - Active query state
 * @param ctx - Query loop context
 * @returns Promise resolving when all registered stop hooks have executed
 */
export async function executeStopHooks(state: QueryState, ctx: QueryLoopContext): Promise<void> {
  await executeAttachedHooks(ctx, { event: 'stop', sessionId: ctx.sessionId }, state)
}

/**
 * Phase 6: checks cumulative billed token usage against configured session token budget.
 *
 * @param state - Active query state
 * @param ctx - Query loop context with optional token budget cap
 * @returns QueryResult with 'budget_exceeded' if cap is breached, or undefined
 */
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

/**
 * Runs the phased agentic query loop, yielding incremental stream events and returning the final result.
 *
 * Executes turns with compaction checks, LLM provider streaming, sequential tool execution,
 * and post-turn hooks until reaching a terminal stop condition (completion, cancellation,
 * budget cap, or error). In the `finally` block, unregisters session tools, runs session-end
 * hooks, flushes journals, and triggers calibration and rule distillation.
 *
 * @param input - User prompt or instruction
 * @param ctx - Query loop context
 * @param signal - Optional abort signal for cancellation
 * @returns AsyncGenerator yielding normalized StreamEvents and returning the final QueryResult
 */
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
  let learnedEvent: Extract<StreamEvent, { type: 'rules_learned' }> | undefined

  try {
    if (ctx.abortSignal?.aborted) {
      exitReason = 'user_cancel'
      recordCancellation(state)
      return cancellationResult(state)
    }

    const firstQuery = state.messages.length === 0
    yield* injectTaskNotifications(state, ctx)
    const readyState = await prepareQueryState(state, ctx)
    try {
      if (firstQuery && !isMemoryDisabled() && state.sessionStartRuleIds?.length) {
        const rules = state.sessionStartRuleIds.flatMap((id) => {
          const rule = state.rules.find((rule) => rule.id === id)
          return rule ? [{ id, confidence: calculateConfidence(rule.alpha, rule.beta) }] : []
        })
        if (rules.length) yield { type: 'rule_recall', trigger: 'session_start', rules }
      }
    } catch (error) {
      dbg('query', 'Failed to display session-start rules', error)
    }

    let consecutiveTruncations = 0
    let intentNudged = false
    while (readyState.turn < ctx.config.maxTurns) {
      if (ctx.abortSignal?.aborted) {
        exitReason = 'user_cancel'
        recordCancellation(readyState)
        return cancellationResult(readyState)
      }

      yield* injectTaskNotifications(readyState, ctx)
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
      consecutiveTruncations =
        streamResult.stopReason === 'max_tokens' ? consecutiveTruncations + 1 : 0

      const hasToolUse = streamResult.assistantBlocks.some((block) => block.type === 'tool_use')
      if (hasToolUse) {
        const toolResult = yield* executeTools(readyState, ctx, streamResult.assistantBlocks)
        if (toolResult.restartLoop) continue
      }

      // Append after surviving tool results so recovery never interrupts call/result pairing.
      if (streamResult.recoveryNote) {
        readyState.messages.push({ role: 'user', content: streamResult.recoveryNote })
      }
      if (consecutiveTruncations >= 3) {
        exitReason = 'fatal_error'
        return {
          exit_reason: 'fatal_error',
          usage: readyState.usage,
          turns: readyState.turn,
          error: 'Query stopped after 3 consecutive truncation recoveries (max_tokens).',
        }
      }

      let stop = !streamResult.recoveryNote && shouldStop(streamResult.assistantBlocks)
      if (stop) {
        const assistantText = streamResult.assistantBlocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        const text = assistantText.trim()
        const lastSentence =
          text
            .replace(/[.!。！\s]+$/u, '')
            .split(/(?<=[.!])\s+|[。！]\s*|\n+/u)
            .at(-1)
            ?.trim() ?? ''
        // Conservative, bounded recovery for short action announcements only.
        const intentOnly =
          text.length < 400 &&
          !/[?？]/u.test(text) &&
          /^(?:(?:(?:now|first)[,\s]+)?(?:i(?:['’]ll|\s+will|['’]m\s+going\s+to|\s+am\s+going\s+to)|let\s+me)\b|first,\s+i\s+(?:need\s+to|am\s+\w+ing)\b|我来|我将|让我|我会|接下来我)/iu.test(
            lastSentence,
          )
        if (ctx.config.intentNudge && !intentNudged && intentOnly) {
          readyState.messages.push({
            role: 'user',
            content:
              'You described what you will do but made no tool call, so nothing happened. If you intend to act, call the tools now. If you are done or need the user, say so explicitly.',
          })
          intentNudged = true
          appendJournal({ kind: 'intent_nudge', turn: readyState.turn })
          stop = false
        }
        if (stop) {
          await executeStopHooks(readyState, ctx)
          exitReason = 'completed'
          return {
            exit_reason: 'completed',
            usage: readyState.usage,
            turns: readyState.turn,
            final_message: assistantText,
          }
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
    await state.pendingCompaction?.cancel()
    state.pendingCompaction = undefined
    const agentTools = sessionAgentTools.get(ctx)
    sessionAgentTools.delete(ctx)
    if (agentTools) {
      for (const tool of agentTools) unregisterTool(tool.name, tool)
    }
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

    await cleanupMcp(ctx)

    try {
      if (ctx.sessionId) {
        await runSessionEndEpisodes(ctx.sessionId, undefined, ctx.repoRoot)
      }
    } catch (error) {
      dbg('query', 'Failed to run session-end episode hook', error)
    }

    try {
      if (ctx.sessionId) {
        ctx.autoDistillAttemptedEpisodeIds ??= new Set<string>()
        const learned = await runSessionEndAutoDistill(ctx.sessionId, ctx.repoRoot, {
          attemptedEpisodeIds: ctx.autoDistillAttemptedEpisodeIds,
        })
        if (!isMemoryDisabled() && (learned.created.length || learned.updated)) {
          learnedEvent = { type: 'rules_learned', ...learned }
        }
      }
    } catch (error) {
      dbg('query', 'Failed to run session-end auto-distillation hook', error)
    }

    try {
      if (ctx.sessionId) {
        await runSessionEndCalibration(ctx.sessionId)
      }
    } catch (error) {
      dbg('query', 'Failed to run session-end calibration hook', error)
    }

    try {
      if (ctx.persistSession && ctx.sessionId) {
        await saveSession(
          {
            sessionId: ctx.sessionId,
            model: state.model,
            repoRoot: ctx.repoRoot,
            messages: ctx.messages ?? state.messages,
          },
          { memoryDir: ctx.memoryDir },
        )
      }
    } catch (error) {
      dbg('query', 'Failed to persist session', error)
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
    // Finish all ledger cleanup before yielding: an early generator.return() caller
    // may not resume a yield in finally. The event still precedes query completion.
    try {
      if (learnedEvent && !isMemoryDisabled()) yield learnedEvent
    } catch (error) {
      dbg('query', 'Failed to display learned rules', error)
    }
  }
}

/**
 * Options for executing a query via the CLI engine.
 */
export interface RunQueryOptions {
  signal?: AbortSignal
  stdoutIsTTY?: boolean
  messages?: CanonicalMessage[]
  persistSession?: boolean
  memoryDir?: string
}

/**
 * Executes a query in non-interactive one-shot CLI mode, streaming progress to standard output.
 *
 * Sets up session context, streams text and tool execution notifications to stdout/stderr,
 * handles task cleanup, flushes session statistics, and logs formatted session summaries.
 *
 * @param userPrompt - User prompt or command instruction to execute
 * @param sandbox - Optional resolved sandbox configuration
 * @param config - Optional configuration overrides
 * @param options - Execution options including initial messages, session persistence, and memory directory
 * @returns Promise resolving when query execution and post-processing finish
 */
export async function runQuery(
  userPrompt: string,
  sandbox?: ResolvedSandboxConfig,
  config?: OctonoesisConfig,
  options: RunQueryOptions = {},
): Promise<void> {
  const sessionId = crypto.randomUUID()
  if (config) setConfiguredModel(config.model)
  const model = getResolvedModel()
  const ctx: ToolContext = {
    repoRoot: getRepoRoot(),
    memoryDir: options.memoryDir,
    persistSession: options.persistSession,
    messages: structuredClone(options.messages ?? []),
    sessionId,
    sessionState: createSessionState(sessionId, model),
    sandbox,
    config,
  }
  const generator = query(userPrompt, ctx, options.signal)
  const textOutput = createMarkdownStream(
    (text) => process.stdout.write(text),
    options.stdoutIsTTY ?? process.stdout.isTTY === true,
  )
  let queryResult: QueryResult | undefined

  try {
    while (true) {
      const step = await generator.next()
      if (step.done) {
        queryResult = step.value
        break
      }
      const event = step.value
      if (event.type === 'text_delta') {
        textOutput.write(event.text)
      } else if (event.type === 'stream_retry') {
        textOutput.flush()
        process.stderr.write(`↻ connection lost, retrying (${event.attempt}/2)\n`)
      } else if (event.type === 'tool_use') {
        textOutput.flush()
        let inputStr = ''
        if (event.input && typeof event.input === 'object') {
          const values = Object.values(event.input)
          if (values.length > 0) inputStr = ` ${values[0]}`
        }
        process.stdout.write(`\n[Tool Call] ${event.name}${inputStr}...\n`)
      } else if (event.type === 'message_end') {
        textOutput.flush()
      } else if (event.type === 'compact') {
        textOutput.flush()
        process.stdout.write(
          `\n✻ Context compacted: ${event.preTokens.toLocaleString('en-US')} → ${event.postTokens.toLocaleString('en-US')} tokens\n`,
        )
      }
    }
  } finally {
    textOutput.flush()
    try {
      await cleanupTasks(ctx)
    } catch (error) {
      dbg('query', 'Failed to clean up background tasks', error)
    }
  }
  await flushSessionStats()
  if (queryResult && ONE_SHOT_FAILURE_REASONS.has(queryResult.exit_reason)) {
    process.stderr.write(`${formatQueryFailure(queryResult)}\n`)
    process.exitCode = 1
    await flushJournal()
    const memoryNotice = formatMemoryUnavailableNotice()
    if (memoryNotice) console.error(memoryNotice)
    const journalNotice = formatJournalFailureNotice()
    if (journalNotice) console.error(journalNotice)
    return
  }

  const priced = ctx.sessionState
    ? estimateCost(ctx.sessionState.usage, ctx.sessionState.model).priced
    : false
  process.stdout.write(
    ctx.sessionState ? `\n${formatSessionSummary(ctx.sessionState, priced)}\n` : '\n',
  )
  await flushJournal()
  const memoryNotice = formatMemoryUnavailableNotice()
  if (memoryNotice) console.error(memoryNotice)
  const journalNotice = formatJournalFailureNotice()
  if (journalNotice) console.error(journalNotice)
}

/** Persist this outcome against the current hot-dir rule, returning its real confidence delta. */
export async function recordRuleOutcome(
  ruleId: string,
  stillFailing: boolean,
  repoRoot: string,
  rulesDir: string = getRulesDir(),
): Promise<{ hit: boolean; before: number; after: number } | undefined> {
  try {
    return await withFileLock(
      `${rulesDir}.lock`,
      async () => {
        const rule = await loadRule(ruleId, rulesDir)
        if (!rule) {
          dbg(
            'query',
            `Outcome skipped for rule ${ruleId}: no longer exists in hot dir ${rulesDir}`,
          )
          return
        }
        const before = calculateConfidence(rule.alpha, rule.beta)
        if (stillFailing) {
          rule.misses++
          rule.beta++
          dbg('query', `Miss recorded for rule ${rule.id}. New misses count: ${rule.misses}`)
        } else {
          rule.hits++
          rule.alpha++
          rule.last_matched_at = new Date().toISOString()
          dbg('query', `Hit recorded for rule ${rule.id}. New hits count: ${rule.hits}`)
        }
        await updateLifecycle(rule, repoRoot)
        await saveRule(rule, rulesDir)
        return { hit: !stillFailing, before, after: calculateConfidence(rule.alpha, rule.beta) }
      },
      RULES_LOCK_OPTIONS,
    )
  } catch (error) {
    if (!(error instanceof LockTimeoutError)) throw error
    warnLockTimeout(error)
  }
}
