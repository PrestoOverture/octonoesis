import { spawnSync } from 'node:child_process'
import type Anthropic from '@anthropic-ai/sdk'
import { callAnthropicStream } from './providers/anthropic'
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

// 1. Automatically register all tools in the registry
registerTool(readTool)
registerTool(globTool)
registerTool(bashTool)
registerTool(writeTool)
registerTool(editTool)
registerTool(grepTool)
registerTool(todoWriteTool)

export type CanonicalMessage =
  | { role: 'user'; content: string | ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[] }
  | { role: 'tool'; tool_use_id: string; content: string | ContentBlock[] }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_done'; id: string; name: string; status: 'done' | 'error' }
  | { type: 'message_end'; usage: Usage }

export type Usage = {
  input_tokens: number
  output_tokens: number
}

export type QueryResult = {
  exit_reason: 'completed' | 'max_turns' | 'fatal_error' | 'user_cancel'
  usage: Usage
  turns: number
  final_message?: string
  error?: string
}

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
 * Normalizes CanonicalMessages to Anthropic MessageParams at call-time.
 */
export function toAnthropicMessages(messages: CanonicalMessage[]): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_use_id,
            content:
              typeof msg.content === 'string'
                ? msg.content
                : msg.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
          },
        ],
      } as Anthropic.MessageParam
    }
    return msg as Anthropic.MessageParam
  })
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

    let finalMessage: Anthropic.Message | null = null

    const apiMessages = toAnthropicMessages(ctx.messages)
    try {
      for await (const event of callAnthropicStream(apiMessages, ctx.abortSignal)) {
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
        } else if (event.type === 'message_done') {
          finalMessage = event.message
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

    if (!finalMessage) {
      return {
        exit_reason: 'fatal_error',
        usage: cumulativeUsage,
        turns: turn,
        error: 'No message returned from API',
      }
    }

    const usage = finalMessage.usage || { input_tokens: 0, output_tokens: 0 }
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
      content: finalMessage.content as ContentBlock[],
    })

    const toolUses = finalMessage.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      const assistantText = finalMessage.content
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

    // Yield tool usage event to the UI
    yield {
      type: 'tool_use',
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
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
