import type Anthropic from '@anthropic-ai/sdk'
import { callAnthropicStream } from './providers/anthropic'
import { readFile } from './tools/Read'
import { dbg } from './utils/debug'

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

    const toolUse = toolUses[0]
    if (!toolUse) {
      continue
    }

    dbg('query', 'tool call detected', { tool: toolUse.name, input: toolUse.input })

    if (toolUse.name !== 'Read') {
      console.error(`Error: Unknown tool "${toolUse.name}" called.`)
      break
    }

    const { path } = toolUse.input as { path: string }
    process.stdout.write(`\n[Tool Call] Read ${path}...\n`)

    let toolResultContent: string
    let isError = false

    try {
      toolResultContent = await readFile({ path })
    } catch (err) {
      isError = true
      toolResultContent = err instanceof Error ? err.message : String(err)
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
