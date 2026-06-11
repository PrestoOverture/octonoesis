import { spawnSync } from 'node:child_process'
import { buildSystemMessages } from './prompts'
import { getProvider, getResolvedModel } from './providers'
import type {
  CanonicalMessage,
  ContentBlock,
  StreamEvent as ProviderStreamEvent,
  Usage,
} from './providers'
import { bashTool } from './tools/Bash'
import { editTool } from './tools/Edit'
import { globTool } from './tools/Glob'
import { grepTool } from './tools/Grep'
import { readTool } from './tools/Read'
import { todoWriteTool } from './tools/TodoWrite'
import { writeTool } from './tools/Write'
import { runTool } from './tools/execute'
import { registerTool } from './tools/registry'
import { dbg } from './utils/debug'
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

export type StreamEvent =
  | ProviderStreamEvent
  | { type: 'tool_done'; id: string; name: string; status: 'done' | 'error' }

export interface ToolContext {
  repoRoot: string
  messages?: CanonicalMessage[]
  abortSignal?: AbortSignal
  [key: string]: unknown
}

let cachedRepoRoot: string | null = null

/**
 * Discovers and caches the Git repository root using `git rev-parse --show-toplevel`.
 * Falls back to process.cwd() if not inside a git repository.
 */
export function getRepoRoot(): string {
  if (cachedRepoRoot) return cachedRepoRoot

  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
    })
    if (result.status === 0 && result.stdout) {
      cachedRepoRoot = result.stdout.trim()
      return cachedRepoRoot
    }
  } catch {}

  cachedRepoRoot = process.cwd()
  return cachedRepoRoot
}

/**
 * Normalized multi-turn query engine generator loop matching the PRD contract.
 */
export async function* query(
  input: string,
  ctx: ToolContext,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, QueryResult, undefined> {
  if (!ctx.messages) {
    ctx.messages = []
  }

  if (signal) {
    ctx.abortSignal = signal
  }

  if (ctx.abortSignal?.aborted) {
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
  let turn = 0
  const cumulativeUsage: Usage = { input_tokens: 0, output_tokens: 0 }

  while (turn < MAX_TURNS) {
    if (ctx.abortSignal?.aborted) {
      return {
        exit_reason: 'user_cancel',
        usage: cumulativeUsage,
        turns: turn - 1,
        error: 'Query aborted by user',
      }
    }
    turn++
    dbg('query', `Starting turn ${turn}/${MAX_TURNS}`)

    const assistantContent: ContentBlock[] = []
    let finalUsage: Usage | null = null

    try {
      const provider = getProvider()
      const resolvedModel = getResolvedModel()
      const activeTools = getAllTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema) as Record<string, unknown>,
      }))

      const { system, dynamicSystem } = await buildSystemMessages(ctx, resolvedModel, {
        ...cumulativeUsage,
      })

      const stream = provider.createMessageStream(ctx.messages, activeTools, {
        model: resolvedModel,
        maxTokens: 4096,
        signal: ctx.abortSignal || new AbortController().signal,
        system,
        dynamicSystem,
      })

      for await (const event of stream) {
        if (ctx.abortSignal?.aborted) {
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
        return {
          exit_reason: 'user_cancel',
          usage: cumulativeUsage,
          turns: turn,
          error: 'Query aborted by user',
        }
      }
      dbg('query', 'Fatal error during LLM streaming', err)
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

      return {
        exit_reason: 'completed',
        usage: cumulativeUsage,
        turns: turn,
        final_message: assistantText,
      }
    }

    const toolUse = toolUses[0]
    if (!toolUse) {
      continue
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
        typeof toolResult.value === 'string' ? toolResult.value : JSON.stringify(toolResult.value)
    } else {
      isError = true
      toolResultContent = JSON.stringify({ error: toolResult.error })
    }

    // Push tool result using the canonical role 'tool'
    ctx.messages.push({
      role: 'tool',
      tool_use_id: toolUse.id,
      content: toolResultContent,
    })
  }

  return {
    exit_reason: 'max_turns',
    usage: cumulativeUsage,
    turns: turn,
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
 * @param userPrompt The starting user prompt.
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

// Helpers
import { getAllTools } from './tools/registry'
