import { setProvider } from '../../../src/providers'
// Uses the same provider injection boundary as signal-shutdown/preload.ts.
import { forkAgent } from '../../../src/providers/fork'
import type { StreamEvent } from '../../../src/providers/types'

setProvider({
  name: 'anthropic',
  async *createMessageStream(messages, _tools, opts) {
    const content = messages.filter((message) => message.role === 'user').at(-1)?.content
    const prompt =
      typeof content === 'string'
        ? content
        : content
            ?.filter((block) => block.type === 'text')
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join('')
    // Deliberately exercise the host's diagnostic routing for both writer paths.
    console.log('HOST_TEST_DIAGNOSTIC')
    process.stdout.write('HOST_TEST_DIRECT_WRITE\n')
    if (prompt === 'fork') {
      const result = await forkAgent({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'test' }],
        tools: [],
        forkPurpose: 'compact',
        signal: opts.signal,
      })
      yield { type: 'text_delta', text: result.text }
    } else if (prompt === 'wait') {
      yield { type: 'text_delta', text: 'waiting' }
      await new Promise<void>((resolve) => {
        if (opts.signal.aborted) resolve()
        else opts.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    } else if (prompt === 'edit-bash') {
      const lastUser = messages.map((message) => message.role).lastIndexOf('user')
      const step = messages.slice(lastUser + 1).filter((message) => message.role === 'tool').length
      const calls = [
        { name: 'Read', input: { path: 'edit.txt' } },
        {
          name: 'Edit',
          input: {
            path: 'edit.txt',
            old_string: 'keep\nold1\nold2\ntail\n',
            new_string: 'keep\nnew\ntail\n',
          },
        },
        { name: 'Bash', input: { command: 'printf ran > bash-ran.txt' } },
      ]
      const call = calls[step]
      if (call) {
        yield { type: 'tool_use', id: `mode-${step}`, ...call }
        yield {
          type: 'message_end',
          stopReason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
        return
      }
    } else if (prompt === 'write' && messages.at(-1)?.role !== 'tool') {
      const events: StreamEvent[] = [
        {
          type: 'tool_use',
          id: 'write-1',
          name: 'Write',
          input: { path: 'approved.txt', content: 'approved\n' },
        },
        {
          type: 'message_end',
          stopReason: 'tool_use',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]
      yield* events
      return
    } else if (prompt?.startsWith('<rewind-notice>')) {
      // The host prefixes the next prompt after a rewind; echo what the model was told.
      yield {
        type: 'text_delta',
        text: `saw-rewind restored-edit=${prompt.includes('restored edit.txt')} user=${prompt.endsWith('\n\nhello')}`,
      }
    } else {
      yield { type: 'text_delta', text: 'hello ' }
      yield { type: 'text_delta', text: 'world' }
      if (prompt === 'context') {
        yield {
          type: 'text_delta',
          text: ` · users=${messages.filter((message) => message.role === 'user').length}`,
        }
      }
    }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  },
})
