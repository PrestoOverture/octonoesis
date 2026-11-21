import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseTranscript, replayTranscript } from '../../src/state/transcript'
import { command } from '../eval/run'
import { mockProvider, toolChunk } from '../helpers/headless'
import { ELX_SPLIT_SEED, ELX_STREAM_SEEDS, elxSplit, resolveFamilies } from './elx'
import { families, generateStream } from './tasks'

const root = path.resolve(import.meta.dir, '../..')

test('ELX split is the recorded 14/6 draw and covers every family exactly once', () => {
  const split = elxSplit()
  expect(ELX_SPLIT_SEED).toBe(20261121)
  expect(split.train.length).toBe(14)
  expect(split.heldout.length).toBe(6)
  expect([...split.train, ...split.heldout].sort()).toEqual([...families].sort())
  // Pinned so the split can never drift after the first student run.
  expect(split.heldout).toEqual([
    'debounce-scheduler',
    'dependency-plan',
    'event-bus',
    'query-string',
    'ranked-vote',
    'token-bucket',
  ])
  expect(resolveFamilies('elx-train')).toEqual(split.train)
  expect(() => resolveFamilies('no-such-family')).toThrow('Unknown family')
})

test('ELX stream-seed blocks are fresh (>= 7) and generate disjoint task variants', () => {
  const seeds = Object.values(ELX_STREAM_SEEDS)
  expect(new Set(seeds).size).toBe(seeds.length)
  for (const seed of seeds) expect(seed > 6).toBe(true)
  const seen = new Map<string, number>()
  for (const seed of seeds)
    for (const task of generateStream(families.length * 80, families.length * 80, seed)) {
      const key = `${task.family}/${task.seed}`
      expect(seen.get(key)).toBeUndefined()
      seen.set(key, seed)
    }
})

async function temporary(prefix: string) {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
}

function calibrateArgs(dir: string, extra: string[]) {
  return [
    process.execPath,
    '--no-env-file',
    path.join(import.meta.dir, 'run.ts'),
    '--calibrate',
    '--provider',
    'openai',
    '--model',
    'mock',
    '--per-family',
    '1',
    '--families',
    'interval-overlay,csv-records',
    '--capture',
    '--output',
    dir,
    ...extra,
  ]
}

test('--capture writes a replayable, redacted transcript per session for selected families only', async () => {
  const dir = await temporary('elx-capture-')
  // Only main-loop requests carry tools; answer a tool call first, then finish.
  const server = mockProvider((body) => {
    const messages = (body.messages ?? []) as { role: string }[]
    const toolTurn = Array.isArray(body.tools) && body.tools.length > 0
    return toolTurn && !messages.some((m) => m.role === 'tool')
      ? [toolChunk('Read', { file_path: 'src/subject.ts' }), finish('tool_calls')]
      : [{ choices: [{ index: 0, delta: { content: 'Done.' } }] }, finish('stop')]
  })
  try {
    const cli = await command(
      calibrateArgs(dir, ['--concurrency', '1']),
      root,
      env(server.port),
      90000,
    )
    expect(cli.code).toBe(0)
    const sessions = await readdir(path.join(dir, 'sessions'))
    expect(sessions.length).toBe(2)
    const config = JSON.parse(await readFile(path.join(dir, 'calibration.json'), 'utf8'))
    expect(config.families).toEqual(['interval-overlay', 'csv-records'])
    expect(config.capture).toBe(true)
    for (const id of sessions) {
      const text = await readFile(path.join(dir, 'sessions', id, 'transcript.jsonl'), 'utf8')
      expect(text).not.toContain('/Users/')
      expect(text).not.toContain(os.homedir())
      expect(text).not.toContain('mock-key')
      const exchanges = replayTranscript(parseTranscript(text))
      expect(exchanges.length).toBe(2)
      const [first, second] = exchanges
      expect(first?.tools.length).toBeGreaterThan(0)
      expect(first?.system).toBeDefined()
      const call = first?.response[0]
      expect(call?.type === 'tool_use' && call.name).toBe('Read')
      // The second request extends the first: prompt, assistant tool call, tool result.
      expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages ?? [])
      expect(second?.messages.length).toBeGreaterThan(first?.messages.length ?? 0)
    }
  } finally {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
}, 120000)

test('--capture voids provider rejections, exits 3, and resume reruns the voided session', async () => {
  const dir = await temporary('elx-void-')
  let reject = true
  // biome-ignore lint/suspicious/noExplicitAny: Bun runtime types are not installed
  const bun = (globalThis as any).Bun
  const server = bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      reject
        ? new Response(
            JSON.stringify({ error: { message: 'quota', type: 'insufficient_quota' } }),
            {
              status: 402,
              headers: { 'content-type': 'application/json' },
            },
          )
        : new Response(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done.' } }] })}\n\ndata: ${JSON.stringify(finish('stop'))}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
  })
  try {
    const first = await command(
      calibrateArgs(dir, ['--concurrency', '1']),
      root,
      env(server.port),
      90000,
    )
    expect(first.code).toBe(3)
    expect(first.stdout).toContain('replace SPARK_API_KEY and resume')
    expect(existsSync(path.join(dir, 'calibration-report.json'))).toBe(false)
    const log = (await readFile(path.join(dir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(log.filter((e) => e.kind === 'void').map((e) => e.reason)).toEqual([402])
    expect(log.filter((e) => e.kind === 'result')).toEqual([])
    reject = false
    const second = await command(
      calibrateArgs(dir, ['--concurrency', '1']),
      root,
      env(server.port),
      90000,
    )
    expect(second.code).toBe(0)
    const report = JSON.parse(await readFile(path.join(dir, 'calibration-report.json'), 'utf8'))
    expect(
      Object.entries(report.summary)
        .filter(([, row]) => (row as { hidden_pass_rate: number | null }).hidden_pass_rate !== null)
        .map(([family]) => family)
        .sort(),
    ).toEqual(['csv-records', 'interval-overlay'])
  } finally {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
}, 180000)

test('--stop-after-sessions and STOP drain without starting more sessions', async () => {
  const dir = await temporary('elx-stop-')
  const server = mockProvider(() => [
    { choices: [{ index: 0, delta: { content: 'Done.' } }] },
    finish('stop'),
  ])
  try {
    const first = await command(
      calibrateArgs(dir, ['--concurrency', '1', '--stop-after-sessions', '1']),
      root,
      env(server.port),
      90000,
    )
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('Stopped; resume with the same --output')
    expect((await readdir(path.join(dir, 'sessions'))).length).toBe(1)
    await writeFile(path.join(dir, 'STOP'), '')
    const second = await command(calibrateArgs(dir, []), root, env(server.port), 90000)
    expect(second.code).toBe(0)
    expect((await readdir(path.join(dir, 'sessions'))).length).toBe(1)
  } finally {
    server.stop(true)
    await rm(dir, { recursive: true, force: true })
  }
}, 180000)

function finish(reason: string) {
  return {
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }
}

function env(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENAI_API_KEY: 'mock-key',
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  }
}
