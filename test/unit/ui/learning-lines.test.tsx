declare const Bun: { stringWidth(text: string): number }
import { expect, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters as strip } from 'node:util'
import chalk from 'chalk'
import { Box, Static, Text, render } from 'ink'
import React from 'react'
import type { StreamEvent } from '../../../src/query'
import { DisplayEntry } from '../../../src/ui/App'
import { seedTranscript, transcriptReducer } from '../../../src/ui/transcript'

const longId = `rule-${'long-id-'.repeat(30)}`
const events: StreamEvent[] = [
  {
    type: 'rule_recall',
    trigger: 'session_start',
    rules: [
      { id: 'one', confidence: 0.6 },
      { id: 'two', confidence: 0.6 },
      { id: 'three', confidence: 0.6 },
    ],
  },
  { type: 'tool_use', id: 'fail', name: 'Bash', input: { command: 'bun test' } },
  { type: 'tool_done', id: 'fail', name: 'Bash', status: 'error', summary: 'exit 1' },
  {
    type: 'rule_recall',
    trigger: 'failure',
    toolUseId: 'fail',
    rules: [
      { id: longId, confidence: 0.6 },
      { id: 'rule-other', confidence: 0.5 },
    ],
  },
  { type: 'tool_use', id: 'pass', name: 'Bash', input: { command: 'bun test' } },
  { type: 'tool_done', id: 'pass', name: 'Bash', status: 'done', summary: 'exit 0' },
  { type: 'rule_outcome', id: longId, hit: true, before: 0.6, after: 0.6667 },
  { type: 'tool_use', id: 'miss', name: 'Bash', input: { command: 'bun test' } },
  { type: 'tool_done', id: 'miss', name: 'Bash', status: 'error', summary: 'exit 1' },
  { type: 'rule_outcome', id: longId, hit: false, before: 0.6, after: 0.5 },
  { type: 'rules_learned', created: [{ id: 'rule-new', status: 'candidate' }], updated: 0 },
  { type: 'rules_learned', created: [], updated: 2 },
  {
    type: 'rules_learned',
    created: [
      { id: 'first', status: 'candidate' },
      { id: longId, status: 'candidate' },
    ],
    updated: 0,
  },
]
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Missing learning frame')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
for (const [columns, rows] of [
  [80, 24],
  [60, 20],
])
  test(`learning Static lines at ${columns}x${rows} preserve adjacency, confidence and styles`, async () => {
    const state = events.reduce((state, event) => transcriptReducer(state, event), seedTranscript())
    const chunks: string[] = []
    const stdout = Object.assign(
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString())
          callback()
        },
      }),
      { columns, rows, isTTY: true },
    )
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {},
      ref() {},
      unref() {},
    })
    const previous = chalk.level
    chalk.level = 3
    const tree = (epoch: number, width: number, entries = state.transcript) => (
      <Box width={width} flexDirection="column">
        <Static key={epoch} items={entries}>
          {(item, i) => <DisplayEntry key={i} item={item} width={width - 1} />}
        </Static>
        <Text>ready</Text>
      </Box>
    )
    const view = render(tree(0, columns ?? 80), {
      stdout: stdout as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as NodeJS.WriteStream,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    try {
      await until(() => strip(chunks.join('')).includes('✻ learned 2 rules:'))
      const output = strip(chunks.join(''))
      const lines = output.split('\n').filter((line) => line.trim())
      expect(output).toContain('✻ recalled 3 rules for this repo')
      expect(output).toContain('✻ learned 1 rule: rule-new (candidate)')
      expect(output).toContain('✻ strengthened 2 rules')
      expect(output).toContain('✻ learned 2 rules: first (candidate), rule-')
      expect(output).not.toContain(longId)
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThan(columns ?? 80)
      const fail = lines.findIndex((line) => line.includes('Bash') && line.includes('exit 1'))
      expect(lines[fail + 1]).toContain('  ↳ rule-')
      expect(lines[fail + 1]).toContain('… · 0.60')
      expect(lines[fail + 2]).toContain('  ↳ rule-other · 0.50')
      const pass = lines.findIndex((line) => line.includes('Bash') && line.includes('exit 0'))
      expect(lines[pass + 1]).toContain('… hit · 0.60 → 0.67')
      expect(lines[pass + 3]).toContain('… miss · 0.60 → 0.50')
      expect(chunks.join('')).toContain('\x1b[35m')
      expect(chunks.join('')).toContain('\x1b[2m')
      // Static keeps items immutable; a resize epoch renders every learning item again.
      chunks.length = 0
      view.rerender(tree(1, 60))
      await until(() => strip(chunks.join('')).includes('✻ learned 2 rules:'))
      const resized = strip(chunks.join(''))
      expect(resized).toContain('✻ recalled 3 rules for this repo')
      expect(resized).toContain('hit · 0.60 → 0.67')
      expect(resized).toContain('miss · 0.60 → 0.50')
      for (const line of resized.split('\n')) expect(Bun.stringWidth(line)).toBeLessThan(60)
      chunks.length = 0
      view.rerender(tree(2, columns ?? 80, seedTranscript().transcript))
      await view.waitUntilRenderFlush()
      expect(strip(chunks.join(''))).not.toContain('✻')
      expect(strip(chunks.join(''))).not.toContain('↳')
      chunks.length = 0
      const resumed = seedTranscript([{ role: 'user', content: 'resumed turn' }], {
        sessionId: 'resume',
        messageCount: 1,
        updatedAt: 'today',
      })
      view.rerender(tree(3, columns ?? 80, resumed.transcript))
      await until(() => strip(chunks.join('')).includes('resumed turn'))
      expect(strip(chunks.join(''))).not.toContain('✻')
      expect(strip(chunks.join(''))).not.toContain('↳')
    } finally {
      view.unmount()
      view.cleanup()
      chalk.level = previous
    }
  })
test('no event, empty events, and resumed canonical messages never fabricate learning', () => {
  const empty = seedTranscript()
  expect(empty.transcript).toEqual([])
  expect(transcriptReducer(empty, { type: 'rules_learned', created: [], updated: 0 })).toBe(empty)
  expect(
    transcriptReducer(empty, { type: 'rule_recall', trigger: 'session_start', rules: [] }),
  ).toBe(empty)
  const resumed = seedTranscript(
    [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'old', name: 'Bash', input: { command: 'bun test' } }],
      },
      { role: 'tool', tool_use_id: 'old', content: '<octo-memory>rule-fix</octo-memory>' },
    ],
    { sessionId: 'old', messageCount: 2, updatedAt: 'today' },
  )
  expect(resumed.transcript.some((item) => item.kind === 'learning')).toBe(false)
  const wrongTool = transcriptReducer(resumed, {
    type: 'rule_recall',
    trigger: 'failure',
    toolUseId: 'missing',
    rules: [{ id: 'rule', confidence: 0.6 }],
  })
  expect(wrongTool).toBe(resumed)
})
test('singular formats and append-only identity', () => {
  let state = seedTranscript()
  for (const event of events) {
    const previous = state.transcript
    state = transcriptReducer(state, event)
    previous.forEach((item, index) => expect(state.transcript[index]).toBe(item))
  }
  const recall = transcriptReducer(seedTranscript(), {
    type: 'rule_recall',
    trigger: 'session_start',
    rules: [{ id: 'one', confidence: 0.6 }],
  })
  expect(recall.transcript[0]).toEqual({
    kind: 'learning',
    prefix: '',
    text: '✻ recalled 1 rule for this repo',
    suffix: '',
  })
})

test('a failing verification can report an outcome and then recall under the same tool', () => {
  const state = events
    .slice(0, 3)
    .reduce((state, event) => transcriptReducer(state, event), seedTranscript())
  const outcome = transcriptReducer(state, {
    type: 'rule_outcome',
    id: 'previous-rule',
    hit: false,
    before: 0.6,
    after: 0.5,
  })
  const recalled = transcriptReducer(outcome, {
    type: 'rule_recall',
    trigger: 'failure',
    toolUseId: 'fail',
    rules: [{ id: 'new-rule', confidence: 0.6 }],
  })
  expect(recalled.transcript.length).toBe(outcome.transcript.length + 1)
  expect(recalled.transcript.at(-1)).toEqual({
    kind: 'learning',
    prefix: '  ↳ ',
    text: 'new-rule',
    suffix: ' · 0.60',
  })
})
