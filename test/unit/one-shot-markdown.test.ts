import { expect, test } from 'bun:test'
import chalk from 'chalk'
import { setProvider } from '../../src/providers'
import type { LLMProvider } from '../../src/providers/types'
import { runQuery } from '../../src/query/engine'
import { renderMarkdown } from '../../src/ui/markdown'
import { restoreEnv } from '../helpers/env'

test('runQuery routes split deltas through the injectable TTY display path', async () => {
  const deltas = ['**bo', 'ld** text\n\n- a', '\n- b']
  const originalWrite = process.stdout.write
  const originalLevel = chalk.level
  const originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY
  chalk.level = 1
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  const provider: LLMProvider = {
    name: 'anthropic',
    async *createMessageStream() {
      for (const text of deltas) yield { type: 'text_delta', text }
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  }
  try {
    for (const stdoutIsTTY of [true, false]) {
      let output = ''
      process.stdout.write = ((text: string) => {
        output += text
        return true
      }) as typeof process.stdout.write
      setProvider(provider)
      await runQuery('hello', undefined, undefined, { stdoutIsTTY })
      // The session summary is separate from the model's text run.
      const expected = stdoutIsTTY ? renderMarkdown(deltas.join('')) : deltas.join('')
      expect(output.slice(0, expected.length)).toBe(expected)
      expect(output.slice(expected.length).startsWith('\n')).toBe(true)
    }
  } finally {
    process.stdout.write = originalWrite
    chalk.level = originalLevel
    restoreEnv('OCTONOESIS_DISABLE_MEMORY', originalDisableMemory)
    setProvider(null)
  }
})
