export type CanonicalMessage =
  | { role: 'user'; content: string | ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[] }
  | { role: 'tool'; tool_use_id: string; content: string | ContentBlock[] }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export type Usage = {
  input_tokens: number
  output_tokens: number
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'message_end'; usage: Usage }

export interface CanonicalTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface LLMProvider {
  name: 'anthropic' | 'openai-compatible'
  createMessageStream(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    opts: { model: string; maxTokens: number; signal: AbortSignal },
  ): AsyncIterable<StreamEvent>
}
