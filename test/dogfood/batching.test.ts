import { afterEach, expect, test } from 'bun:test'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { command } from '../eval/run'
import type { Job, Observation } from './model'
import * as runner from './run'
import { digest } from './tasks'

const dirs: string[] = []
async function temporary() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-batching-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

// Exercise the real scheduler, event commits, checkpoint copies, archival and reports.
// Only the expensive provider/grader session is replaced in orchestration tests.
const session: typeof runner.runSession = async (dir, job, _plan, ledger) => {
  const workspace = path.join(dir, 'sessions', job.id)
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, 'evidence'), job.id)
  await writeFile(path.join(ledger, 'checkpoint'), job.id)
  return {
    job,
    ledger,
    status: 'PASS',
    fingerprints: [],
    hits: 0,
    misses: 0,
    rules_before: 0,
  }
}
async function events(dir: string) {
  const text = await readFile(path.join(dir, 'events.jsonl'), 'utf8').catch(() => '')
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
async function noReport(dir: string) {
  const names = await readdir(dir)
  expect(names).not.toContain('report.json')
  expect(names).not.toContain('report.md')
}
async function drained(dir: string) {
  const pending = new Set<string>()
  for (const event of await events(dir)) {
    if (event.kind === 'started') pending.add(event.job.id)
    if (event.kind === 'result') pending.delete(event.observation.job.id)
    if (event.kind === 'void') for (const job of event.jobs) pending.delete(job.id)
  }
  expect([...pending]).toEqual([])
  expect(await readdir(dir)).not.toContain('.run-lock')
}
const rejected = (row: Observation, code: number): Observation => ({
  ...row,
  status: 'ERROR',
  error: `${code} {"error":{"message":"provider rejected request"}}`,
})

test('STOP present before first training starts no sessions and can resume', async () => {
  const dir = await temporary()
  await writeFile(path.join(dir, 'STOP'), '')
  let calls = 0
  const result = await runner.run({ dryRun: true, output: dir }, async (...args) => {
    calls++
    return session(...args)
  })
  expect(calls).toBe(0)
  expect(result.exitCode).toBe(0)
  expect(result.result).toBeUndefined()
  await noReport(dir)
  await drained(dir)
  await rm(path.join(dir, 'STOP'))
  expect(
    (await runner.run({ dryRun: true, output: dir }, session)).result?.completed_jobs,
  ).toBeGreaterThan(0)
}, 90000)

test('STOP during training drains the job without starting another or using a partial checkpoint', async () => {
  const dir = await temporary()
  const started: string[] = []
  const result = await runner.run({ dryRun: true, output: dir }, async (...args) => {
    started.push(args[1].id)
    await writeFile(path.join(dir, 'STOP'), '')
    return session(...args)
  })
  expect(started).toEqual(['train-0'])
  expect(result.result).toBeUndefined()
  expect(result.exitCode).toBe(0)
  await drained(dir)
  await noReport(dir)
}, 90000)

test('STOP drains both in-flight eval pairs at concurrency 2, including their second arms', async () => {
  const dir = await temporary()
  const admitted = new Set<string>()
  const starts: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const result = await runner.run(
    { dryRun: true, output: dir, concurrency: 2 },
    async (...args) => {
      const job = args[1]
      if (job.arm !== 'train') {
        starts.push(job.id)
        admitted.add(job.task.id)
        if (admitted.size === 2) {
          await writeFile(path.join(dir, 'STOP'), '')
          release()
        }
        await gate
      }
      return session(...args)
    },
  )
  expect(admitted.size).toBe(2)
  expect(starts.length).toBe(4)
  expect(result.result).toBeUndefined()
  await drained(dir)
  await noReport(dir)
}, 90000)

test('--stop-after-pairs 2 reserves exactly 2 pairs at concurrency 2; resume adds no ERRORs', async () => {
  const dir = await temporary()
  const options = { dryRun: true, output: dir, concurrency: 2 }
  const stopped = await runner.run({ ...options, stopAfterPairs: 2 }, session)
  expect(stopped.exitCode).toBe(0)
  expect(stopped.result).toBeUndefined()
  const log = await events(dir)
  expect(log.filter((e) => e.kind === 'started' && e.job.arm !== 'train').length).toBe(4)
  expect(
    new Set(
      log.filter((e) => e.kind === 'started' && e.job.arm !== 'train').map((e) => e.job.task.id),
    ).size,
  ).toBe(2)
  await drained(dir)
  await noReport(dir)
  const resumed = await runner.run(options, session)
  expect(resumed.result?.completed_jobs).toBe(resumed.result?.planned_jobs)
  expect(
    (await events(dir)).filter((e) => e.kind === 'result' && e.observation.status === 'ERROR'),
  ).toEqual([])
  expect((await events(dir)).filter((e) => e.kind === 'started').length).toBe(
    resumed.result?.planned_jobs,
  )
}, 90000)

test('429 in second arm voids whole pair and both ledgers; resume reruns both in the same order and reports void counts', async () => {
  const dir = await temporary()
  const options = { dryRun: true, output: dir, stopAfterPairs: 1 }
  const order: string[] = []
  await runner.run(options, async (...args) => {
    const row = await session(...args)
    if (row.job.arm !== 'train') {
      order.push(row.job.id)
      if (order.length === 2) {
        // A real runSession parses a mocked CLI HTTP rejection without a journal.
        return runner.runSession(
          args[0],
          args[1],
          args[2],
          args[3],
          false,
          async (argv, cwd, env, deadline) =>
            argv[0] === process.execPath
              ? {
                  code: 1,
                  timed_out: false,
                  stderr: '',
                  stdout: JSON.stringify({
                    exit_reason: 'fatal_error',
                    turns: 0,
                    usage: { input_tokens: 0, output_tokens: 0 },
                    duration_ms: 1,
                    tool_calls: [],
                    final_text: '',
                    session_id: 'rejected',
                    error: rejected(row, 429).error,
                  }),
                }
              : command(argv, cwd, env, deadline),
        )
      }
    }
    return row
  })
  expect(order.length).toBe(2)
  const log = await events(dir)
  const voids = log.filter((e) => e.kind === 'void')
  expect(voids.length).toBe(1)
  const entry = voids[0]
  expect(entry.reason).toBe(429)
  for (const id of order) {
    expect(
      await readFile(path.join(dir, 'voided', entry.id, 'ledgers', id, 'checkpoint'), 'utf8'),
    ).toBe(id)
    expect(
      await readFile(path.join(dir, 'voided', entry.id, 'sessions', id, 'evidence'), 'utf8'),
    ).toBe(id)
    expect(await readdir(path.join(dir, 'ledgers'))).not.toContain(id)
  }
  expect(log.filter((e) => e.kind === 'result' && e.observation.status === 'ERROR')).toEqual([])
  await drained(dir)
  await noReport(dir)
  const retry: string[] = []
  const resumed = await runner.run({ dryRun: true, output: dir }, async (...args) => {
    if (args[1].arm !== 'train') retry.push(args[1].id)
    return session(...args)
  })
  expect(retry.slice(0, 2)).toEqual(order)
  expect(resumed.result?.completed_jobs).toBe(resumed.result?.planned_jobs)
  expect(resumed.result?.voids).toEqual({
    total: 1,
    training_jobs: 0,
    evaluation_pairs: 1,
    reasons: { 401: 0, 402: 0, 403: 0, 429: 1 },
    events: [{ jobs: order, reason: 429, error: entry.error }],
  })
  expect(await readFile(path.join(dir, 'report.md'), 'utf8')).toContain('Voided units: 1')
  const before = await readFile(path.join(dir, 'events.jsonl'), 'utf8')
  await runner.run({ dryRun: true, output: dir }, session)
  expect(await readFile(path.join(dir, 'events.jsonl'), 'utf8')).toBe(before)
}, 90000)

for (const codes of [[401], [402], [403], [429, 429, 429]]) {
  test(`provider breaker ${codes.join('/')} drains and exits 3 without a report`, async () => {
    const dir = await temporary()
    let pairs = 0
    const result = await runner.run({ dryRun: true, output: dir }, async (...args) => {
      const row = await session(...args)
      if (row.job.arm !== 'train') return rejected(row, codes[pairs++] ?? 429)
      return row
    })
    expect(result.exitCode).toBe(3)
    expect(result.result).toBeUndefined()
    expect(pairs).toBe(codes.length)
    expect((await events(dir)).filter((e) => e.kind === 'void').length).toBe(codes.length)
    await drained(dir)
    await noReport(dir)
  }, 90000)
}

test('a non-void pair resets the consecutive 429 breaker', async () => {
  const dir = await temporary()
  let arms = 0
  const result = await runner.run(
    { dryRun: true, output: dir, stopAfterPairs: 6 },
    async (...args) => {
      const row = await session(...args)
      if (row.job.arm !== 'train') {
        arms++
        // Two void pairs, one committed pair, then three void pairs.
        if (arms !== 3 && arms !== 4) return rejected(row, 429)
      }
      return row
    },
  )
  expect(result.exitCode).toBe(3)
  expect(arms).toBe(7)
  expect((await events(dir)).filter((e) => e.kind === 'void').length).toBe(5)
}, 90000)

test('voided training reruns from the same prior checkpoint and never advances training lineage', async () => {
  const dir = await temporary()
  const prior: string[] = []
  const first = await runner.run({ dryRun: true, output: dir }, async (...args) => {
    const job = args[1]
    if (job.id === 'train-1') prior.push(await readFile(path.join(args[3], 'checkpoint'), 'utf8'))
    const row = await session(...args)
    return job.id === 'train-1' ? rejected(row, 429) : row
  })
  expect(first.result).toBeUndefined()
  expect(first.exitCode).toBe(0)
  expect((await events(dir)).filter((e) => e.kind === 'started').map((e) => e.job.id)).toEqual([
    'train-0',
    'train-1',
  ])
  await drained(dir)
  const resumed = await runner.run(
    { dryRun: true, output: dir, stopAfterPairs: 1 },
    async (...args) => {
      if (args[1].id === 'train-1')
        prior.push(await readFile(path.join(args[3], 'checkpoint'), 'utf8'))
      if (args[1].id === 'train-2')
        expect(await readFile(path.join(args[3], 'checkpoint'), 'utf8')).toBe('train-1')
      return session(...args)
    },
  )
  expect(prior).toEqual(['train-0', 'train-0'])
  expect(resumed.exitCode).toBe(0)
  expect(
    (await events(dir)).filter((e) => e.kind === 'started' && e.job.id === 'train-1').length,
  ).toBe(2)
  await drained(dir)
}, 90000)

test('all non-provider ERRORs keep never-retry semantics across batched resumes', async () => {
  const dir = await temporary()
  const errors = [
    'fatal error',
    'Missing/invalid headless JSON',
    'SIGKILL',
    'Query aborted by user',
    'timeout after 429ms',
    'HTTP 500 internal server error',
  ]
  const options = { dryRun: true, output: dir }
  const calls: string[] = []
  const failed: typeof session = async (...args) => {
    calls.push(args[1].id)
    const row = await session(...args)
    return { ...row, status: 'ERROR', error: errors[calls.length % errors.length] }
  }
  await runner.run({ ...options, stopAfterPairs: 2 }, failed)
  const originalCalls = [...calls]
  const resumed = await runner.run(options, failed)
  expect(new Set(calls).size).toBe(calls.length)
  expect(calls.slice(0, originalCalls.length)).toEqual(originalCalls)
  expect(resumed.result?.completed_jobs).toBe(calls.length)
  expect(resumed.result?.arms['rules-on']?.errors).toBeGreaterThan(0)
  expect(resumed.result?.voids.total).toBe(0)
  const before = calls.length
  await runner.run(options, failed)
  expect(calls.length).toBe(before)
}, 90000)

test('durable void replay finishes archival without recovering the voided starts as ERROR', async () => {
  const dir = await temporary()
  const plan = await runner.preregister(dir, { dryRun: true })
  const job = plan.jobs[0] as Job
  const ledger = path.join(dir, 'ledgers', job.id)
  await mkdir(ledger, { recursive: true })
  await writeFile(path.join(ledger, 'partial'), 'unusable')
  await appendFile(
    path.join(dir, 'events.jsonl'),
    [
      { kind: 'started', job, ledger, plan_hash: digest(plan) },
      { kind: 'void', id: 'interrupted-move', jobs: [job], reason: 429, error: '429 rejected' },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(''),
  )
  const result = await runner.run(
    { dryRun: true, output: dir, stopAfterPairs: 1 },
    async (...args) => {
      expect(await readdir(args[3])).not.toContain('partial')
      return session(...args)
    },
  )
  expect(result.exitCode).toBe(0)
  expect(
    await readFile(path.join(dir, 'voided/interrupted-move/ledgers', job.id, 'partial'), 'utf8'),
  ).toBe('unusable')
  expect(
    (await events(dir)).filter((e) => e.kind === 'result' && e.observation.status === 'ERROR'),
  ).toEqual([])
  await drained(dir)
}, 90000)

test('classification is limited to provider HTTP rejection strings and preregistration records the outcome-blind policy', async () => {
  for (const code of [401, 402, 403, 429]) {
    for (const error of [
      `${code} rejected`,
      `Error: ${code} rejected`,
      `HTTP ${code}: rejected`,
      `API status code: ${code}`,
    ])
      expect(runner.providerRejection(error)).toBe(code)
  }
  for (const error of [
    undefined,
    'fatal',
    'invalid JSON',
    'Query aborted by user',
    'timeout 429ms',
    'exit 401',
    'HTTP 500',
  ])
    expect(runner.providerRejection(error)).toBeUndefined()
  const dir = await temporary()
  const plan = await runner.preregister(dir, { dryRun: true, stopAfterPairs: 1 })
  expect(plan.stopping_rule).toContain('Outcome-blind')
  expect(plan.stopping_rule).toContain('same prior checkpoint')
  expect(JSON.stringify(plan)).not.toContain('stopAfterPairs')
  expect(await runner.preregister(dir, { dryRun: true, stopAfterPairs: 2 })).toEqual(plan)
  await expect(runner.preregister(dir, { dryRun: true, provider: 'openai' })).rejects.toThrow(
    'differs',
  )
  await expect(runner.preregister(dir, { model: 'other', dryRun: false })).rejects.toThrow(
    'differs',
  )
}, 90000)

test('mock provider HTTP 401 survives real headless session, voids training and CLI exits 3 with key replacement advice', async () => {
  const dir = await temporary()
  // biome-ignore lint/suspicious/noExplicitAny: Bun runtime types are not installed
  const bun = (globalThis as any).Bun
  const server = bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({ error: { message: 'replace key', type: 'authentication_error' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
  })
  try {
    const result = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'run.ts'),
        '--provider',
        'spark',
        '--model',
        'mock',
        '--output',
        dir,
      ],
      runner.projectRoot,
      {
        ...process.env,
        SPARK_API_KEY: 'mock',
        SPARK_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
      30000,
    )
    expect(result.code).toBe(3)
    expect(result.stdout).toContain('replace SPARK_API_KEY and resume')
    const log = await events(dir)
    expect(log.filter((e) => e.kind === 'void').map((e) => e.reason)).toEqual([401])
    expect(log.filter((e) => e.kind === 'result')).toEqual([])
    await drained(dir)
    await noReport(dir)
  } finally {
    server.stop(true)
  }
}, 90000)

test('breaker drains concurrent admitted pairs without scheduling replacements', async () => {
  const dir = await temporary()
  const admitted = new Set<string>()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let rejectedTask: string | undefined
  const result = await runner.run(
    { dryRun: true, output: dir, concurrency: 3 },
    async (...args) => {
      const job = args[1]
      if (job.arm === 'train') return session(...args)
      if (!rejectedTask) rejectedTask = job.task.id
      admitted.add(job.task.id)
      if (admitted.size === 3) release()
      await gate
      if (job.task.id !== rejectedTask) await new Promise((resolve) => setTimeout(resolve, 20))
      const row = await session(...args)
      return job.task.id === rejectedTask ? rejected(row, 401) : row
    },
  )
  expect(result.exitCode).toBe(3)
  expect(admitted.size).toBe(3)
  const log = await events(dir)
  expect(log.filter((e) => e.kind === 'started' && e.job.arm !== 'train').length).toBe(5)
  expect(log.filter((e) => e.kind === 'result' && e.observation.job.arm !== 'train').length).toBe(4)
  await drained(dir)
  await noReport(dir)
}, 90000)

test('three consecutive voided training attempts across resumes trip the 429 breaker', async () => {
  const dir = await temporary()
  const options = { dryRun: true, output: dir }
  const failure: typeof session = async (...args) => rejected(await session(...args), 429)
  expect((await runner.run(options, failure)).exitCode).toBe(0)
  expect((await runner.run(options, failure)).exitCode).toBe(0)
  expect((await runner.run(options, failure)).exitCode).toBe(3)
  expect((await events(dir)).filter((e) => e.kind === 'started').map((e) => e.job.id)).toEqual([
    'train-0',
    'train-0',
    'train-0',
  ])
  await drained(dir)
  await noReport(dir)
}, 90000)

test('STOP exits 0 between key rotations even without SPARK_API_KEY', async () => {
  const dir = await temporary()
  await writeFile(path.join(dir, 'STOP'), '')
  const result = await command(
    [
      process.execPath,
      '--no-env-file',
      path.join(import.meta.dir, 'run.ts'),
      '--provider',
      'spark',
      '--model',
      'mock',
      '--output',
      dir,
    ],
    runner.projectRoot,
    { ...process.env, SPARK_API_KEY: '' },
    10000,
  )
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('Stopped; resume with the same --output')
  expect((await events(dir)).filter((e) => e.kind === 'started')).toEqual([])
  await noReport(dir)
  await drained(dir)
}, 30000)
