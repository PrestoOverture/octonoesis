import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CanonicalMessage, CanonicalTool } from '../../src/providers/types'
import {
  TRANSCRIPT_FILE_ENV,
  TranscriptEncoder,
  type TranscriptExchange,
  createRedactor,
  getTranscriptRecorder,
  parseTranscript,
  redactDeep,
  replayTranscript,
} from '../../src/state/transcript'

const repoRoot = '/Users/alice/runs/s1/repo'
const home = '/Users/alice'
const secret = 'spark-live-secret-123456'
const redact = createRedactor({ repoRoot, home, secrets: [secret] })

const tools: CanonicalTool[] = [
  { name: 'Read', description: 'Read a file', inputSchema: { type: 'object' } },
]

function exchanges(): TranscriptExchange[] {
  const user: CanonicalMessage = { role: 'user', content: `Fix ${repoRoot}/src/subject.ts` }
  const call: CanonicalMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Reading.' },
      {
        type: 'tool_use',
        id: 't1',
        name: 'Read',
        input: { file_path: `${repoRoot}/src/subject.ts` },
      },
    ],
  }
  const result: CanonicalMessage = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: `KEY=${secret}\nconst api_key = "sk-abcdefghijkl"\nhome ${home}/x`,
      },
    ],
  }
  const done: CanonicalMessage = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
  const summary: CanonicalMessage = { role: 'user', content: 'Summary of earlier work.' }
  const base = { model: 'm', system: `sys at ${repoRoot}`, tools, stopReason: 'tool_use' as const }
  const usage = { input_tokens: 1, output_tokens: 1 }
  return [
    { ...base, messages: [user], response: call.content as never, usage },
    { ...base, messages: [user, call, result], response: done.content as never, usage },
    // Compaction rewrites history: the shared prefix drops to zero.
    {
      ...base,
      messages: [summary, done],
      response: done.content as never,
      usage,
      stopReason: 'end_turn',
    },
  ]
}

describe('transcript capture', () => {
  test('replay reproduces every redacted request byte-for-byte, including after compaction', () => {
    const encoder = new TranscriptEncoder(redact, 'sess')
    const input = exchanges()
    const lines = parseTranscript(input.map((e) => JSON.stringify(encoder.encode(e))).join('\n'))
    const replayed = replayTranscript(lines)
    expect(replayed.length).toBe(input.length)
    input.forEach((exchange, i) => {
      const expected = redactDeep(exchange, redact)
      expect(JSON.stringify(replayed[i]?.messages)).toBe(JSON.stringify(expected.messages))
      expect(replayed[i]).toEqual(expected)
    })
    expect(lines.map((l) => l.prefix)).toEqual([0, 1, 0])
    // System prompt and tools are stored once.
    expect(lines.filter((l) => l.system !== undefined).length).toBe(1)
    expect(lines.filter((l) => l.tools !== undefined).length).toBe(1)
  })

  test('stored lines contain no secrets and no local paths', () => {
    const encoder = new TranscriptEncoder(redact)
    const text = exchanges()
      .map((e) => JSON.stringify(encoder.encode(e)))
      .join('\n')
    expect(text).not.toContain(secret)
    expect(text).not.toContain('sk-abcdefghijkl')
    expect(text).not.toContain('/Users/')
    expect(text).toContain('/workspace/repo/src/subject.ts')
    expect(text).toContain('/home/user/x')
  })

  test('replay rejects a corrupt prefix', () => {
    const encoder = new TranscriptEncoder(redact)
    const [first] = exchanges().map((e) => encoder.encode(e))
    expect(() => replayTranscript([{ ...first, prefix: 5 }] as never)).toThrow('bad prefix')
  })

  describe('recorder', () => {
    let dir = ''
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true })
    })

    test('is off unless the env var is set', () => {
      expect(getTranscriptRecorder(repoRoot, 'x', {})).toBeUndefined()
    })

    test('appends one JSON line per exchange', async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'transcript-'))
      const file = path.join(dir, 'nested', 't.jsonl')
      const recorder = getTranscriptRecorder(repoRoot, 'rec', { [TRANSCRIPT_FILE_ENV]: file })
      for (const e of exchanges()) recorder?.record(e)
      const lines = parseTranscript(await readFile(file, 'utf8'))
      expect(lines.map((l) => l.seq)).toEqual([0, 1, 2])
      expect(replayTranscript(lines)[1]?.messages.length).toBe(3)
    })
  })
})
