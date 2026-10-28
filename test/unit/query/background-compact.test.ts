import { expect, test } from 'bun:test'
import type { CanonicalMessage } from '../../../src/providers/types'
import { BackgroundCompaction } from '../../../src/query/backgroundCompact'
import { CompactAbortError, type CompactResult } from '../../../src/query/compact'

function fixture(): CanonicalMessage[] {
  return [
    { role: 'user', content: 'Keep constraint EXACT_42' },
    { role: 'assistant', content: [{ type: 'text', text: 'old context '.repeat(1000) }] },
    { role: 'user', content: 'current task' },
    { role: 'assistant', content: [{ type: 'text', text: 'recent work' }] },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
  ]
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function result(messages: CanonicalMessage[]): CompactResult {
  return {
    summary: 'Old work summarized.',
    pinnedHead: structuredClone(messages[0] as CanonicalMessage),
    messagesKept: structuredClone(messages.slice(-3)),
    preCompactTokens: 4000,
    postCompactTokens: 100,
  }
}

test('runs without blocking, uses an immutable snapshot, and retains appended tool pairs', async () => {
  const source = fixture()
  const gate = deferred<CompactResult>()
  const started = deferred<void>()
  let input: CanonicalMessage[] | undefined
  const job = new BackgroundCompaction(
    source,
    { systemPrompt: 'system' },
    async (messages, opts) => {
      input = messages
      expect(opts.recordEvent).toBe(false)
      started.resolve()
      return gate.promise
    },
  )
  await started.promise
  expect(input).toEqual(source)
  expect(input).not.toBe(source)
  expect(await job.poll(false)).toBeUndefined()
  const suffix: CanonicalMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'new', name: 'Read', input: { path: 'new.ts' } }],
    },
    { role: 'tool', tool_use_id: 'new', content: 'NEW_FACT_99' },
    { role: 'user', content: 'New instruction after snapshot' },
  ]
  source.push(...suffix)
  gate.resolve(result(input as CanonicalMessage[]))
  const outcome = await job.poll(true)
  expect(outcome && 'result' in outcome).toBe(true)
  if (!outcome || !('result' in outcome)) return
  expect(job.replacement(source, outcome.result)?.slice(-3)).toEqual(suffix)
  expect(JSON.stringify(source)).not.toContain('<octo-compact-summary>')
  source[0] = { role: 'user', content: 'edited original prefix' }
  expect(job.replacement(source, outcome.result)).toBeUndefined()
  await job.cancel()
})

test('captures rejected jobs and propagates parent cancellation without unhandled rejection', async () => {
  const controller = new AbortController()
  const started = deferred<void>()
  const job = new BackgroundCompaction(
    fixture(),
    { systemPrompt: 'system', signal: controller.signal },
    async (_messages, opts) => {
      started.resolve()
      return new Promise((_resolve, reject) =>
        opts.signal?.addEventListener('abort', () => reject(new CompactAbortError()), {
          once: true,
        }),
      )
    },
  )
  await started.promise
  controller.abort()
  await job.cancel()
  const outcome = await job.poll(true)
  expect(outcome && 'error' in outcome && outcome.error instanceof CompactAbortError).toBe(true)
  const failed = new BackgroundCompaction(fixture(), { systemPrompt: 'system' }, async () => {
    throw new Error('API unavailable')
  })
  expect(await failed.poll(true)).toEqual({ error: new Error('API unavailable') })
})
