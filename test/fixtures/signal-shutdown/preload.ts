import { mock } from 'bun:test'
import * as ink from 'ink'
import { setProvider } from '../../../src/providers'
import { forkAgent, getActiveForkPids } from '../../../src/providers/fork'
import * as tasks from '../../../src/tasks/framework'

const realRender = ink.render

setProvider({
  name: 'anthropic',
  async *createMessageStream(_messages, _tools, opts) {
    process.stdout.write('PROVIDER_READY\n')
    yield { type: 'text_delta', text: 'waiting' }
    const keepAlive = setInterval(() => {}, 1000)
    await new Promise<void>((resolve) => {
      if (opts.signal.aborted) resolve()
      else opts.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    clearInterval(keepAlive)
    process.stdout.write('PROVIDER_ABORTED\n')
    yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
  },
})

if (process.env.SIGNAL_TEST_HANG === '1') {
  mock.module('../../../src/tasks/framework', () => ({
    ...tasks,
    cleanupTasks: async () => {
      process.stdout.write('CLEANUP_HANG\n')
      await new Promise(() => {})
    },
  }))
}

if (process.env.SIGNAL_TEST_TUI === '1') {
  Object.defineProperty(process.stdin, 'isTTY', { value: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: true })
  process.stdout.columns = 100
  process.stdout.rows = 40
  process.stdin.setRawMode = (enabled: boolean) => {
    process.stdout.write(enabled ? 'RAW_ON\n' : 'RAW_OFF\n')
    return process.stdin
  }
  mock.module('ink', () => ({
    ...ink,
    render: (...args: Parameters<typeof ink.render>) => {
      const instance = realRender(args[0], { ...args[1], interactive: true })
      setTimeout(() => process.stdout.write('TUI_READY\n'), 100)
      return instance
    },
  }))
}

if (process.env.SIGNAL_TEST_FORK === '1') {
  void forkAgent({
    systemPrompt: 'wait',
    messages: [{ role: 'user', content: 'wait' }],
    tools: [],
    forkPurpose: 'compact',
  })
  const timer = setInterval(() => {
    const pid = getActiveForkPids()[0]
    if (pid) {
      process.stdout.write(`FORK_PID=${pid}\n`)
      clearInterval(timer)
    }
  }, 10)
}
