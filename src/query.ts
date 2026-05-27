import { spawnSync } from 'node:child_process'
import type Anthropic from '@anthropic-ai/sdk'
import { callAnthropicStream } from './providers/anthropic'
import { bashTool } from './tools/Bash'
import { globTool } from './tools/Glob'
import { readTool } from './tools/Read'
import { runTool } from './tools/execute'
import { registerTool } from './tools/registry'
import { dbg } from './utils/debug'

// 1. Automatically register all 3 tools in the registry
registerTool(readTool)
registerTool(globTool)
registerTool(bashTool)

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
 * Run a multi-turn agent query loop with a maximum of 5 turns.
 * @param userPrompt The starting user prompt.
 */
export async function runQuery(userPrompt: string): Promise<void> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: userPrompt }],
    },
  ]

  // Initialize the Tool Context with the cached repository root
  const repoRoot = getRepoRoot()
  const ctx = { repoRoot }

  const MAX_TURNS = 5
  let turn = 0

  while (turn < MAX_TURNS) {
    turn++
    dbg('query', `Starting turn ${turn}/${MAX_TURNS}`)

    let finalMessage: Anthropic.Message | null = null

    for await (const event of callAnthropicStream(messages)) {
      if (event.type === 'text_delta') {
        process.stdout.write(event.text)
      } else if (event.type === 'message_done') {
        finalMessage = event.message
      }
    }

    console.log(finalMessage)

    if (!finalMessage) {
      throw new Error('No message returned from API')
    }

    const hasText = finalMessage.content.some((c) => c.type === 'text' && c.text.length > 0)
    if (hasText) {
      process.stdout.write('\n')
    }

    messages.push({
      role: 'assistant',
      content: finalMessage.content,
    })

    const toolUses = finalMessage.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      break
    }

    // Execute the detected tool using the unified runTool pipeline
    const toolUse = toolUses[0]
    if (!toolUse) {
      continue
    }

    dbg('query', 'tool call detected', { tool: toolUse.name, input: toolUse.input })
    let inputStr = ''
    if (toolUse.input && typeof toolUse.input === 'object') {
      const vals = Object.values(toolUse.input)
      if (vals.length > 0) {
        inputStr = ` ${vals[0]}`
      }
    }
    process.stdout.write(`\n[Tool Call] ${toolUse.name}${inputStr}...\n`)

    let toolResultContent: string
    let isError = false

    const toolResult = await runTool(toolUse.name, toolUse.input, ctx)

    if (toolResult.ok) {
      toolResultContent =
        typeof toolResult.value === 'string' ? toolResult.value : JSON.stringify(toolResult.value)
    } else {
      isError = true
      // Return structured error payloads in JSON format with is_error: true
      toolResultContent = JSON.stringify({ error: toolResult.error })
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: toolResultContent,
          is_error: isError,
        },
      ],
    })
  }
}
