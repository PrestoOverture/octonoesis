import crypto from 'node:crypto'
import { runSessionEndCalibration } from './memory/calibration/hook'
import { runSessionEndEpisodes } from './memory/episodes/hook'
import { appendJournal, flushJournal, setSessionId } from './memory/journal'
import { updateLifecycle } from './memory/rules/lifecycle'
import { findMatchingRules, formatMatchAdvice } from './memory/rules/match'
import { loadAllRules, saveRule } from './memory/rules/store'
import { buildSystemMessages } from './prompts'
import { getProvider, getResolvedModel } from './providers'
import type {
  CanonicalMessage,
  ContentBlock,
  StreamEvent as ProviderStreamEvent,
  Usage,
} from './providers'
import type { QueryLoopContext } from './query/types'
import { bashTool } from './tools/Bash'
import { editTool } from './tools/Edit'
import { globTool } from './tools/Glob'
import { grepTool } from './tools/Grep'
import { readTool } from './tools/Read'
import { todoWriteTool } from './tools/TodoWrite'
import type { ToolContext } from './tools/Tool'
import { writeTool } from './tools/Write'
import { runTool } from './tools/execute'
import { registerTool } from './tools/registry'
import { getAllTools } from './tools/registry'
import { dbg } from './utils/debug'
import { getRepoRoot } from './utils/path'
import { zodToJsonSchema } from './utils/schema'

// 1. Automatically register all tools in the registry
registerTool(readTool)
registerTool(globTool)
registerTool(bashTool)
registerTool(writeTool)
registerTool(editTool)
registerTool(grepTool)
registerTool(todoWriteTool)

export type { CanonicalMessage, ContentBlock, Usage }
export type { ToolContext } from './tools/Tool'
export type { VerifyResultWithRun } from './query/types'
export { getRepoRoot }

export type StreamEvent =
  | ProviderStreamEvent
  | { type: 'tool_done'; id: string; name: string; status: 'done' | 'error' }

/**
 * Normalized multi-turn query engine generator loop matching the PRD contract.
 *
 * @param input The user prompt string.
 * @param ctx The tool execution context.
 * @param signal The optional abort signal for cancellation.
 * @return An async generator yielding stream events and resolving to query results.
 */
export async function* query(
  input: string,
  ctx: QueryLoopContext,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, QueryResult, undefined> {
  if (!ctx.sessionId) {
    ctx.sessionId = crypto.randomUUID()
  }
  setSessionId(ctx.sessionId as string)

  const rules = await loadAllRules()
  ctx.injectedRules = ctx.injectedRules || []
  ctx.recordedRuleOutcomes = ctx.recordedRuleOutcomes || new Set<string>()

  // Log user initial prompt event
  appendJournal({
    kind: 'user',
    digest: crypto.createHash('sha256').update(input).digest('hex'),
    cancel: false,
  })

  let exitReason: 'completed' | 'max_turns' | 'fatal_error' | 'user_cancel' = 'fatal_error'
  const cumulativeUsage: Usage = { input_tokens: 0, output_tokens: 0 }
  let turn = 0

  try {
    if (!ctx.messages) {
      ctx.messages = []
    }

    if (signal) {
      ctx.abortSignal = signal
    }

    if (ctx.abortSignal?.aborted) {
      exitReason = 'user_cancel'
      appendJournal({
        kind: 'user',
        digest: crypto.createHash('sha256').update(input).digest('hex'),
        cancel: true,
      })
      return {
        exit_reason: 'user_cancel',
        usage: { input_tokens: 0, output_tokens: 0 },
        turns: 0,
        error: 'Query aborted by user',
      }
    }

    // Push user input to conversational history
    ctx.messages.push({
      role: 'user',
      content: [{ type: 'text', text: input }],
    })

    const MAX_TURNS = 50
    const provider = getProvider()
    const resolvedModel = getResolvedModel()
    const activeTools = getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
    }))
    const { system, dynamicSystem } = await buildSystemMessages(ctx, resolvedModel, cumulativeUsage)
    ctx.firstTurnDynamicSystem = dynamicSystem

    while (turn < MAX_TURNS) {
      if (ctx.abortSignal?.aborted) {
        exitReason = 'user_cancel'
        appendJournal({
          kind: 'user',
          digest: crypto.createHash('sha256').update(input).digest('hex'),
          cancel: true,
        })
        return {
          exit_reason: 'user_cancel',
          usage: cumulativeUsage,
          turns: turn,
          error: 'Query aborted by user',
        }
      }
      turn++
      dbg('query', `Starting turn ${turn}/${MAX_TURNS}`)

      // Log turn event
      appendJournal({
        kind: 'turn',
        turn,
      })

      const assistantContent: ContentBlock[] = []
      let finalUsage: Usage | null = null

      try {
        const stream = provider.createMessageStream(ctx.messages, activeTools, {
          model: resolvedModel,
          maxTokens: 4096,
          signal: ctx.abortSignal || new AbortController().signal,
          system,
          dynamicSystem: ctx.firstTurnDynamicSystem as string,
        })

        for await (const event of stream) {
          if (ctx.abortSignal?.aborted) {
            exitReason = 'user_cancel'
            appendJournal({
              kind: 'user',
              digest: crypto.createHash('sha256').update(input).digest('hex'),
              cancel: true,
            })
            return {
              exit_reason: 'user_cancel',
              usage: cumulativeUsage,
              turns: turn,
              error: 'Query aborted by user',
            }
          }

          if (event.type === 'text_delta') {
            yield { type: 'text_delta', text: event.text }

            const lastBlock = assistantContent[assistantContent.length - 1]
            if (lastBlock && lastBlock.type === 'text') {
              lastBlock.text += event.text
            } else {
              assistantContent.push({ type: 'text', text: event.text })
            }
          } else if (event.type === 'tool_use') {
            yield {
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: event.input,
            }

            assistantContent.push({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: event.input,
            })
          } else if (event.type === 'message_end') {
            finalUsage = event.usage
          }
        }
      } catch (err) {
        if (ctx.abortSignal?.aborted) {
          exitReason = 'user_cancel'
          appendJournal({
            kind: 'user',
            digest: crypto.createHash('sha256').update(input).digest('hex'),
            cancel: true,
          })
          return {
            exit_reason: 'user_cancel',
            usage: cumulativeUsage,
            turns: turn,
            error: 'Query aborted by user',
          }
        }
        dbg('query', 'Fatal error during LLM streaming', err)
        exitReason = 'fatal_error'
        const errorMsg = err instanceof Error ? err.message : String(err)
        return {
          exit_reason: 'fatal_error',
          usage: cumulativeUsage,
          turns: turn,
          error: errorMsg,
        }
      }

      const usage = finalUsage || { input_tokens: 0, output_tokens: 0 }
      cumulativeUsage.input_tokens += usage.input_tokens
      cumulativeUsage.output_tokens += usage.output_tokens

      // Yield message_end containing this turn's usage
      yield {
        type: 'message_end',
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        },
      }

      // Record the assistant response to conversational history
      ctx.messages.push({
        role: 'assistant',
        content: assistantContent,
      })

      const toolUses = assistantContent.filter(
        (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
      )

      if (toolUses.length === 0) {
        const assistantText = assistantContent
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')

        exitReason = 'completed'

        return {
          exit_reason: 'completed',
          usage: cumulativeUsage,
          turns: turn,
          final_message: assistantText,
        }
      }

      for (const toolUse of toolUses) {
        if (ctx.abortSignal?.aborted) {
          exitReason = 'user_cancel'
          appendJournal({
            kind: 'user',
            digest: crypto.createHash('sha256').update(input).digest('hex'),
            cancel: true,
          })
          break
        }

        dbg('query', 'tool call detected', { tool: toolUse.name, input: toolUse.input })

        let toolResultContent: string
        let isError = false

        const toolResult = await runTool(toolUse.name, toolUse.input, ctx)

        // Yield tool completion details to coordinate with TUI ToolCards
        yield {
          type: 'tool_done',
          id: toolUse.id,
          name: toolUse.name,
          status: toolResult.ok ? 'done' : 'error',
        }

        if (toolResult.ok) {
          toolResultContent =
            typeof toolResult.value === 'string'
              ? toolResult.value
              : JSON.stringify(toolResult.value)
        } else {
          isError = true
          toolResultContent = JSON.stringify({ error: toolResult.error })
        }

        // 1. Hit/Miss outcome tracking for injected rules
        const verifyResult = ctx._lastVerifyResultForQuery
        if (verifyResult?.isVerificationRun) {
          ctx._lastVerifyResultForQuery = undefined
          const injectedRulesList = ctx.injectedRules
          const recordedOutcomes = ctx.recordedRuleOutcomes

          if (injectedRulesList && injectedRulesList.length > 0 && recordedOutcomes) {
            const postSigs = verifyResult.fingerprints.map((fp) => fp.fine)

            for (const { rule, fingerprint } of injectedRulesList) {
              if (recordedOutcomes.has(rule.id)) {
                continue
              }

              const stillFailing = postSigs.includes(fingerprint.fine)

              if (!stillFailing) {
                // HIT! The signature that triggered the rule has disappeared
                rule.hits++
                rule.alpha++
                rule.last_matched_at = new Date().toISOString()
                recordedOutcomes.add(rule.id)
                dbg('query', `Hit recorded for rule ${rule.id}. New hits count: ${rule.hits}`)

                await updateLifecycle(rule, ctx.repoRoot)
                await saveRule(rule)
              } else {
                // MISS! The signature is still present
                rule.misses++
                rule.beta++
                recordedOutcomes.add(rule.id)
                dbg('query', `Miss recorded for rule ${rule.id}. New misses count: ${rule.misses}`)

                await updateLifecycle(rule, ctx.repoRoot)
                await saveRule(rule)
              }
            }
          }
        }

        // 2. Post-failure rule matching and injection
        const lastFingerprints = ctx._lastFingerprints
        if (lastFingerprints) {
          ctx._lastFingerprints = undefined

          if (toolUse.name === 'Bash' && !ctx.verificationCommand) {
            ctx.verificationCommand = (toolUse.input as { command: string }).command
          }

          const matches = findMatchingRules(lastFingerprints, rules)
          if (matches.length > 0) {
            const adviceBlocks = matches.map(formatMatchAdvice).join('\n\n')
            const octoMemoryBlock = `\n\n<octo-memory>\n${adviceBlocks}\n</octo-memory>`
            toolResultContent += octoMemoryBlock

            for (const match of matches) {
              ctx.injectedRules?.push({
                rule: match.rule,
                fingerprint: match.fingerprint,
              })
            }
          }
        }

        // Push tool result using the canonical role 'tool'
        ctx.messages.push({
          role: 'tool',
          tool_use_id: toolUse.id,
          content: toolResultContent,
        })
      }
    }

    exitReason = 'max_turns'
    return {
      exit_reason: 'max_turns',
      usage: cumulativeUsage,
      turns: turn,
    }
  } finally {
    appendJournal({
      kind: 'session',
      exit_reason: exitReason,
      usage: {
        input_tokens: cumulativeUsage.input_tokens,
        output_tokens: cumulativeUsage.output_tokens,
      },
      model: getResolvedModel(),
    })
    await flushJournal()

    try {
      if (ctx.sessionId) {
        await runSessionEndEpisodes(ctx.sessionId as string)
      }
    } catch (err) {
      dbg('query', 'Failed to run session-end episode hook', err)
    }

    try {
      if (ctx.sessionId) {
        await runSessionEndCalibration(ctx.sessionId as string)
      }
    } catch (err) {
      dbg('query', 'Failed to run session-end calibration hook', err)
    }

    if (process.env.DEBUG === '1' || process.argv.includes('--debug')) {
      try {
        const { readCalibrationRecords, aggregateCalibrationStats } = await import(
          './memory/calibration/stats.ts'
        )
        const { formatStatsTable } = await import('./memory/calibration/format.ts')
        const records = await readCalibrationRecords()
        const statsList = aggregateCalibrationStats(records)
        const table = formatStatsTable(statsList)
        dbg('calibration', `\n${table}`)
      } catch (err) {
        dbg('query', 'Failed to print debug calibration summary', err)
      }
    }
  }
}

export type QueryResult = {
  exit_reason: 'completed' | 'max_turns' | 'fatal_error' | 'user_cancel'
  usage: Usage
  turns: number
  final_message?: string
  error?: string
}

/**
 * Simple compatibility wrapper mapping the query() generator to process standard stdout/stderr streams.
 * Keeps CLI mode and integration tests passing successfully without revisions.
 *
 * @param userPrompt The starting user prompt.
 * @return A promise that resolves when the query has completed.
 */
export async function runQuery(userPrompt: string): Promise<void> {
  const ctx: ToolContext = { repoRoot: getRepoRoot() }
  const generator = query(userPrompt, ctx)

  for await (const event of generator) {
    if (event.type === 'text_delta') {
      process.stdout.write(event.text)
    } else if (event.type === 'tool_use') {
      let inputStr = ''
      if (event.input && typeof event.input === 'object') {
        const vals = Object.values(event.input)
        if (vals.length > 0) {
          inputStr = ` ${vals[0]}`
        }
      }
      process.stdout.write(`\n[Tool Call] ${event.name}${inputStr}...\n`)
    }
  }
  process.stdout.write('\n')
}
