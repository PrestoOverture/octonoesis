import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CanonicalMessage, CanonicalTool } from '../../src/providers/types'
import { TranscriptEncoder, type TranscriptExchange } from '../../src/state/transcript'
import { buildDataset, leakCheck, scrubSample, segmentEnds, toSample } from './elx-dataset'

const tools: CanonicalTool[] = [{ name: 'Read', description: 'r', inputSchema: { type: 'object' } }]
const usage = { input_tokens: 1, output_tokens: 1 }
const user: CanonicalMessage = { role: 'user', content: 'Fix it' }
const call: CanonicalMessage = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a.ts' } }],
}
const result: CanonicalMessage = { role: 'tool', tool_use_id: 'c1', content: 'file text' }
const done = [{ type: 'text' as const, text: 'Done.' }]

function ex(
  messages: CanonicalMessage[],
  response: TranscriptExchange['response'],
): TranscriptExchange {
  return { model: 'm', system: 'sys', tools, messages, response, stopReason: 'end_turn', usage }
}

test('a continuous session is one segment; a rewritten history starts a new one', () => {
  const continuous = [ex([user], call.content), ex([user, call, result], done)]
  expect(segmentEnds(continuous)).toEqual([1])
  const compacted = [...continuous, ex([{ role: 'user', content: 'summary' }], done)]
  expect(segmentEnds(compacted)).toEqual([1, 2])
})

test('a sample is the exact provider request plus the final assistant turn', () => {
  const sample = toSample(ex([user, call, result], done), {
    session: 's',
    family: 'f',
    seed: 1,
    segment: 0,
    run: 'r',
  })
  expect(sample.messages.map((m) => m.role)).toEqual([
    'system',
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
  expect(sample.messages[2]).toEqual({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } },
    ],
  })
  expect(sample.messages[4]).toEqual({ role: 'assistant', content: 'Done.', tool_calls: undefined })
  expect(sample.tools[0]?.function.name).toBe('Read')
})

test('leak check flags local paths, tokens and key literals', () => {
  expect(leakCheck('ok /workspace/repo /home/user')).toEqual([])
  expect(leakCheck('at /Users/alice/x')).toEqual(['local user path'])
  expect(leakCheck('sk-abcdefghijk')).toEqual(['sk- token'])
  expect(leakCheck('k=spark-secret-xyz', ['spark-secret-xyz'])).toEqual(['key literal'])
})

test('scrubSample removes the account name and harness run path, keeping similar words', () => {
  const output =
    'drwxr-xr-x 2 alice staff 64 .\nalice-tools malice\n/home/user/projects/octonoesis-dogfood/elx-p2/ledgers/train-1/tasks/bash-a.log'
  const sample = toSample(
    ex([user, call, { role: 'tool', tool_use_id: 'c1', content: output }], done),
    { session: 's', family: 'f', seed: 1, segment: 0, run: 'r' },
  )
  const text = JSON.stringify(scrubSample(sample, 'alice').messages)
  expect(text).toContain('drwxr-xr-x 2 user staff')
  expect(text).toContain('alice-tools malice')
  expect(text).toContain('/home/user/.octonoesis/tasks/bash-a.log')
  expect(leakCheck('2 alice staff', [], 'alice')).toEqual(['local username'])
  expect(leakCheck('alice-tools malice', [], 'alice')).toEqual([])
  expect(leakCheck('/home/user/projects/octonoesis-dogfood/x')).toEqual(['harness path'])
})

test('buildDataset keeps a rerun that follows a void', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'elx-dataset-'))
  try {
    const job = { id: 'r', arm: 'train', task: { id: 'r', family: 'csv-records', seed: 1 } }
    const events = [
      { kind: 'void', jobs: [job], reason: 429 },
      { kind: 'result', observation: { job, status: 'PASS', hidden_status: 'PASS' } },
    ]
    await writeFile(
      path.join(dir, 'events.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    )
    const encoder = new TranscriptEncoder((t) => t, 'r')
    await mkdir(path.join(dir, 'sessions', 'r'), { recursive: true })
    await writeFile(
      path.join(dir, 'sessions', 'r', 'transcript.jsonl'),
      `${JSON.stringify(encoder.encode(ex([user], done)))}\n`,
    )
    const built = await buildDataset([dir], 'alice')
    expect(built.samples.map((s) => s.meta.session)).toEqual(['r'])
    const key = `${path.basename(dir)}/r`
    const filtered = await buildDataset([dir], 'alice', new Set([key]))
    expect(filtered.samples).toEqual([])
    expect(filtered.perFamily).toEqual({})
    expect(filtered.excluded).toEqual([key])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildDataset keeps final-hidden-PASS, non-ERROR, non-void sessions of training families', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'elx-dataset-'))
  try {
    const job = (id: string, family: string) => ({
      id,
      arm: 'train',
      task: { id, family, seed: 1, split: 'train' },
    })
    const events = [
      {
        kind: 'result',
        observation: { job: job('a', 'csv-records'), status: 'PASS', hidden_status: 'PASS' },
      },
      // first tested repair failed, final submission passed: still a verified trajectory
      {
        kind: 'result',
        observation: { job: job('e', 'csv-records'), status: 'FAIL', hidden_status: 'PASS' },
      },
      {
        kind: 'result',
        observation: { job: job('b', 'csv-records'), status: 'FAIL', hidden_status: 'FAIL' },
      },
      // untrusted measurement
      {
        kind: 'result',
        observation: { job: job('f', 'csv-records'), status: 'ERROR', hidden_status: 'PASS' },
      },
      // held-out family: never in training data
      {
        kind: 'result',
        observation: { job: job('c', 'event-bus'), status: 'PASS', hidden_status: 'PASS' },
      },
      {
        kind: 'result',
        observation: { job: job('d', 'utf8-codec'), status: 'PASS', hidden_status: 'PASS' },
      },
      { kind: 'void', jobs: [job('d', 'utf8-codec')], reason: 429 },
    ]
    await writeFile(
      path.join(dir, 'events.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    )
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const encoder = new TranscriptEncoder((t) => t, id)
      await mkdir(path.join(dir, 'sessions', id), { recursive: true })
      const lines = [ex([user], call.content), ex([user, call, result], done)].map((e) =>
        JSON.stringify(encoder.encode(e)),
      )
      await writeFile(path.join(dir, 'sessions', id, 'transcript.jsonl'), `${lines.join('\n')}\n`)
    }
    const built = await buildDataset([dir])
    expect(built.samples.map((s) => s.meta.session)).toEqual(['a', 'e'])
    expect(built.perFamily).toEqual({ 'csv-records': 2 })
    expect(built.missing).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
