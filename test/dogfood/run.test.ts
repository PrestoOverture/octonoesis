import { afterEach, expect, test } from 'bun:test'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { restoreEnv } from '../helpers/env'
import { assertIsolatedOutput, preregister, projectRoot, run, sessionEnvironment } from './run'
import { digest, generateStream } from './tasks'

const dirs: string[] = []
async function temporary() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-tests-')))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function ledgerSnapshot(): Promise<string> {
  const files: Record<string, string> = {}
  async function visit(dir: string) {
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, e.name)
        if (e.isDirectory()) await visit(file)
        else files[file] = (await readFile(file)).toString('base64')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await visit(path.join(projectRoot, '.octonoesis'))
  return digest(files)
}

test('ledger isolation rejects repo paths, .octonoesis, and symlink aliases without writes', async () => {
  const before = await ledgerSnapshot()
  const dir = await temporary()
  await symlink(projectRoot, path.join(dir, 'alias'))
  await expect(assertIsolatedOutput(path.join(projectRoot, 'test/dogfood/output'))).rejects.toThrow(
    'outside',
  )
  await expect(
    run({ dryRun: true, output: path.join(projectRoot, '.octonoesis/forbidden') }),
  ).rejects.toThrow('outside')
  await expect(assertIsolatedOutput(path.join(dir, 'alias/output'))).rejects.toThrow('outside')
  await expect(assertIsolatedOutput(path.join(dir, '.octonoesis'))).rejects.toThrow('outside')
  expect(await ledgerSnapshot()).toBe(before)
})

test('keyless end-to-end: preregistration precedes sessions, training accumulates, arms differ, reports and resume are immutable', async () => {
  const before = await ledgerSnapshot()
  const dir = await temporary()
  const originals = new Map(
    ['OCTONOESIS_MEMORY_DIR', 'OCTONOESIS_DISABLE_MEMORY', 'OCTONOESIS_DISABLE_AUTO_DISTILL'].map(
      (key) => [key, process.env[key]],
    ),
  )
  try {
    process.env.OCTONOESIS_MEMORY_DIR = path.join(projectRoot, '.octonoesis')
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    process.env.OCTONOESIS_DISABLE_AUTO_DISTILL = '1'
    const plan = await preregister(dir, { dryRun: true })
    expect((await readdir(dir)).sort()).toEqual(['preregistration.json', 'stream.json'])
    expect(plan.test).toContain('agent wall-clock budget exhaustion are task FAIL')
    expect(plan.test).toContain('Spawn/provider failures')
    const environment = sessionEnvironment('/fixture', path.join(dir, 'ledger'), plan)
    expect(environment.OCTONOESIS_DISABLE_MEMORY).toBeUndefined()
    expect(environment.OCTONOESIS_DISABLE_AUTO_DISTILL).toBeUndefined()
    expect(environment.OCTONOESIS_MEMORY_DIR).toBe(path.join(dir, 'ledger'))
    expect(environment.SPARK_API_KEY).toBeUndefined()
    const { result } = await run({ dryRun: true, output: dir })
    expect(result.completed_jobs).toBe(50)
    expect(result.verdict).toBe('inconclusive')
    expect(result.arms['rules-off']?.errors).toBe(0)
    expect(result.arms['rules-on']?.errors).toBe(0)
    expect(result.primary.risk_difference).toBeGreaterThan(0)
    const events = (await readFile(path.join(dir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const starts = events.filter((e) => e.kind === 'started')
    const observations = events.filter((e) => e.kind === 'result').map((e) => e.observation)
    expect(starts.length).toBe(50)
    const wrongFirst = observations.find((r) => r.first_attempt?.public_status === 'FAIL')
    expect(wrongFirst).toBeDefined()
    expect(wrongFirst.status).toBe('FAIL')
    expect(wrongFirst.hidden_status).toBe('PASS')
    expect(wrongFirst.observed_repair_failure).toBe(true)
    expect(wrongFirst.observed_repair_resolution).toBe(true)
    expect(starts.every((e) => e.plan_hash === digest(plan))).toBe(true)
    expect((await stat(path.join(dir, 'preregistration.json'))).birthtimeMs).toBeLessThan(
      (await stat(path.join(dir, 'sessions/train-0/task.json'))).birthtimeMs,
    )
    expect(observations[0].rules_before).toBe(0)
    expect(observations[5].rules_before).toBeGreaterThan(0)
    expect(
      observations.filter((r) => r.job.arm === 'rules-off').every((r) => r.rules_before === 0),
    ).toBe(true)
    expect(
      observations.filter((r) => r.job.arm === 'rules-on').every((r) => r.rules_before > 0),
    ).toBe(true)
    expect(observations.flatMap((r) => r.fingerprints).length).toBeGreaterThan(6)
    const reportJSON = await readFile(path.join(dir, 'report.json'), 'utf8')
    expect(JSON.parse(reportJSON).primary.risk_difference).toBe(result.primary.risk_difference)
    expect(await readFile(path.join(dir, 'report.md'), 'utf8')).toContain('inconclusive')
    const log = await readFile(path.join(dir, 'events.jsonl'), 'utf8')
    await run({ dryRun: true, output: dir })
    expect(await readFile(path.join(dir, 'events.jsonl'), 'utf8')).toBe(log)
    expect(await readFile(path.join(dir, 'report.json'), 'utf8')).toBe(reportJSON)
    expect(await ledgerSnapshot()).toBe(before)
  } finally {
    for (const [key, value] of originals) restoreEnv(key, value)
  }
}, 120000)

test('interrupted sessions and torn appends resume without retries or deleting evidence', async () => {
  const dir = await temporary()
  const plan = await preregister(dir, { dryRun: true })
  const prefix = `${plan.jobs.map((job) => JSON.stringify({ kind: 'started', job, ledger: 'interrupted', plan_hash: digest(plan) })).join('\n')}\n{"kind":"res`
  await writeFile(path.join(dir, 'events.jsonl'), prefix)
  const { result } = await run({ dryRun: true, output: dir })
  expect(result.verdict).toBe('inconclusive')
  expect(result.completed_jobs).toBe(plan.jobs.length)
  const log = await readFile(path.join(dir, 'events.jsonl'), 'utf8')
  expect(log.startsWith(prefix)).toBe(true)
  expect(log).toContain('recovered-tail')
  expect(log).toContain('Interrupted session')
  expect(await readdir(dir)).not.toContain('sessions')
  await run({ dryRun: true, output: dir })
  expect(await readFile(path.join(dir, 'events.jsonl'), 'utf8')).toBe(log)
})

test('running lock and changed preregistration/config fail closed before sessions', async () => {
  const dir = await temporary()
  await writeFile(path.join(dir, '.run-lock'), String(process.pid))
  await expect(run({ dryRun: true, output: dir })).rejects.toThrow('active')
  await rm(path.join(dir, '.run-lock'))
  const plan = await preregister(dir, { dryRun: true })
  await expect(preregister(dir, { provider: 'spark', model: 'spark-x2.6' })).rejects.toThrow(
    'differs',
  )
  await appendFile(
    path.join(dir, 'events.jsonl'),
    `${JSON.stringify({ kind: 'started', job: plan.jobs[0], ledger: 'x', plan_hash: 'changed' })}\n`,
  )
  await expect(run({ output: dir, dryRun: true })).rejects.toThrow('changed')
  expect(await readdir(dir)).not.toContain('sessions')
})

test('evaluation concurrency preserves pairs, outcomes, training lineage and hashed within-pair order', async () => {
  const serialDir = await temporary()
  const parallelDir = await temporary()
  const serial = await run({ dryRun: true, output: serialDir, concurrency: 1 })
  const parallel = await run({ dryRun: true, output: parallelDir, concurrency: 3 })
  expect(parallel.result.primary).toEqual(serial.result.primary)
  expect(parallel.result.sensitivity).toEqual(serial.result.sensitivity)
  expect(parallel.result.arms).toEqual(serial.result.arms)
  const events = async (dir: string) =>
    (await readFile(path.join(dir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const serialEvents = await events(serialDir)
  const parallelEvents = await events(parallelDir)
  const outcomes = (list: typeof serialEvents) =>
    list
      .filter((e) => e.kind === 'result')
      .map((e) => ({
        id: e.observation.job.id,
        status: e.observation.status,
        fingerprints: e.observation.fingerprints,
        hits: e.observation.hits,
        misses: e.observation.misses,
        rules_before: e.observation.rules_before,
        turns: e.observation.output?.turns,
        usage: e.observation.output?.usage,
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  expect(outcomes(parallelEvents)).toEqual(outcomes(serialEvents))
  const plan = parallel.result.preregistration
  expect(plan.evaluation_concurrency).toBe(3)
  const firstEval = parallelEvents.findIndex((e) => e.kind === 'started' && e.job.arm !== 'train')
  const firstResult = parallelEvents.findIndex(
    (e) => e.kind === 'result' && e.observation.job.arm !== 'train',
  )
  expect(
    parallelEvents.slice(firstEval, firstResult).filter((e) => e.kind === 'started').length,
  ).toBe(3)
  expect(parallelEvents.slice(0, firstEval).filter((e) => e.kind === 'result').length).toBe(10)
  for (const task of plan.tasks.filter((t) => t.split === 'heldout')) {
    const jobs = plan.jobs.filter((j) => j.task.id === task.id)
    const first = jobs[0]
    const second = jobs[1]
    expect(
      parallelEvents.findIndex((e) => e.kind === 'result' && e.observation.job.id === first?.id),
    ).toBeLessThan(parallelEvents.findIndex((e) => e.kind === 'started' && e.job.id === second?.id))
  }
  const log = await readFile(path.join(parallelDir, 'events.jsonl'), 'utf8')
  await run({ dryRun: true, output: parallelDir, concurrency: 3 })
  expect(await readFile(path.join(parallelDir, 'events.jsonl'), 'utf8')).toBe(log)
  await expect(run({ dryRun: true, output: parallelDir, concurrency: 2 })).rejects.toThrow(
    'differs',
  )
}, 120000)

test('preregisters the stream seed and rejects a changed stream on resume', async () => {
  const dir = await temporary()
  const plan = await preregister(dir, { dryRun: true, streamSeed: 2 })
  expect(
    JSON.parse(await readFile(path.join(dir, 'preregistration.json'), 'utf8')).stream_seed,
  ).toBe(2)
  expect(plan.tasks).toEqual(generateStream(10, 20, 2))
  expect(await preregister(dir, { dryRun: true, streamSeed: 2 })).toEqual(plan)
  await expect(preregister(dir, { dryRun: true })).rejects.toThrow('Resume')
})
