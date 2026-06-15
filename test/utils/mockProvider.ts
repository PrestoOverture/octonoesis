import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent,
} from '../../src/providers/types'

export class MockProvider implements LLMProvider {
  name = 'anthropic' as const
  private eventQueues: StreamEvent[][] = []

  constructor(eventQueues: StreamEvent[][]) {
    this.eventQueues = eventQueues
  }

  async *createMessageStream(
    messages: CanonicalMessage[],
    tools: CanonicalTool[],
    opts: {
      model: string
      maxTokens: number
      signal: AbortSignal
      system?: string
      dynamicSystem?: string
    },
  ): AsyncIterable<StreamEvent> {
    const queue = this.eventQueues.shift()
    if (!queue) {
      throw new Error('MockProvider: No event queue configured for this turn.')
    }
    for (const event of queue) {
      if (opts.signal.aborted) {
        break
      }
      yield event
    }
  }
}
