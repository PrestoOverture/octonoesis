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

  /**
   * Indicates whether sending messages to agents can run concurrently.
   *
   * @returns True, as sending a message to a background agent mailbox is safe to run concurrently.
   */
  isConcurrencySafe(): boolean {
    return true
  }

  /**
   * Indicates whether SendMessage is read-only.
   *
   * @returns True, allowing inter-agent messaging without write permission prompts.
   */
  isReadOnly(): boolean {
    return true
  }

  /**
   * Delivers a message string to an active background agent task.
   *
   * @param input - Contains target agentId and the message text to deliver.
   * @returns ToolResult indicating delivery confirmation or failure reason.
   */
  async call(input: SendMessageInput): Promise<ToolResult<string>> {
    const result = sendLocalAgentMessage(input.agentId, input.message)
    return result.ok ? { ok: true, value: 'Message delivered.' } : result
  }
}
