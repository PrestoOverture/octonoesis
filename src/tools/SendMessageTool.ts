import { z } from 'zod'
import { sendLocalAgentMessage } from '../tasks/localAgent'
import type { Tool, ToolResult } from './Tool'

const SendMessageInputSchema = z.object({
  agentId: z.string().min(1),
  message: z.string().min(1),
})

type SendMessageInput = z.infer<typeof SendMessageInputSchema>

export class SendMessageTool implements Tool<SendMessageInput, string> {
  readonly name = 'SendMessage'
  readonly description = 'Send a message to a currently running background agent.'
  readonly inputSchema = SendMessageInputSchema

  isConcurrencySafe(): boolean {
    return true
  }

  isReadOnly(): boolean {
    return true
  }

  async call(input: SendMessageInput): Promise<ToolResult<string>> {
    const result = sendLocalAgentMessage(input.agentId, input.message)
    return result.ok ? { ok: true, value: 'Message delivered.' } : result
  }
}
