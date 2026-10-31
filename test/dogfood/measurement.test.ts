import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HeadlessResult } from '../../src/headless'
import { command } from '../eval/run'
import { calibrationGate } from './calibration'
import { sessionStatus } from './endpoint'
import type { Observation } from './model'
import { preregister, runSession } from './run'
import { families, generateStream, materialize } from './tasks'

const result = { code: 0, stdout: '', stderr: '', timed_out: false }
test('turn and wall-clock exhaustion are task failures; provider failures and external kills are operational', () => {
  const output = { exit_reason: 'max_turns' } as HeadlessResult
  expect(sessionStatus({ ...result, code: 1 }, result, output)).toBe('FAIL')
  expect(sessionStatus({ ...result, code: 1, timed_out: true }, result)).toBe('FAIL')
  expect(
    sessionStatus({ ...result, code: 1 }, result, { ...output, exit_reason: 'fatal_error' }),
  ).toBe('ERROR')
  expect(sessionStatus({ ...result, signal: 'SIGTERM' }, result, output)).toBe('ERROR')
  expect(
    sessionStatus(result, { ...result, code: 1 }, { ...output, exit_reason: 'completed' }),
  ).toBe('FAIL')
})

test('a deadline-killed session without JSON/journal is FAIL; a CLI spawn failure is ERROR', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dogfood-deadline-'))
  try {
    const plan = { mode: 'dry-run' as const, provider: 'spark', model: 'scripted-provider-v1' }
    const task = generateStream()[0]
    if (!task) throw new Error('Missing task')
    const job = { id: 'deadline', task: { ...task, timeout_s: 0.001 }, arm: 'train' as const }
    const timedOut = await runSession(dir, job, plan, path.join(dir, 'deadline-ledger'))
    expect(timedOut.status).toBe('FAIL')
    expect(timedOut.error).toContain('wall-clock budget exhausted')
    const cli = JSON.parse(await readFile(path.join(dir, 'sessions/deadline/cli.json'), 'utf8'))
    expect(cli.timed_out).toBe(true)
    expect(timedOut.output).toBeUndefined()
    const failedSpawn = await runSession(
      dir,
      { ...job, id: 'spawn' },
      plan,
      path.join(dir, 'spawn-ledger'),
      false,
      (args, cwd, env, deadline) =>
        command(
          args[0] === process.execPath ? ['/nonexistent-dogfood-cli'] : args,
          cwd,
          env,
          deadline,
        ),
    )
    expect(failedSpawn.status).toBe('ERROR')
    expect(failedSpawn.error).toContain('nonexistent-dogfood-cli')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const sampleSize = families.length * 10
const lowerFailures = sampleSize / 5
const upperFailures = (sampleSize * 7) / 10

function rows(failures: number): Observation[] {
  return generateStream(sampleSize, 1)
    .filter((t) => t.split === 'train')
    .map((task, i) => ({
      job: { id: task.id, task, arm: 'train' },
      status: i < failures ? 'FAIL' : 'PASS',
      hidden_status: 'PASS',
      first_attempt: {
        source_hash: 'tested',
        public_status: i < failures ? 'FAIL' : 'PASS',
        hidden_status: 'PASS',
      },
      observed_repair_failure: i < failures,
      observed_repair_resolution: i < failures,
      fingerprints: [],
      hits: 0,
      misses: 0,
      rules_before: 1,
      ledger: 'synthetic',
    }))
}
test('pooled calibration uses inclusive count boundaries, coverage and observable signal', () => {
  expect(calibrationGate(rows(lowerFailures)).eligible).toBe(true)
  expect(calibrationGate(rows(upperFailures)).eligible).toBe(true)
  expect(calibrationGate(rows(lowerFailures - 1)).eligible).toBe(false)
  expect(calibrationGate(rows(upperFailures + 1)).eligible).toBe(false)
  expect(
    calibrationGate(rows(lowerFailures).map((r) => ({ ...r, first_attempt: undefined }))).eligible,
  ).toBe(false)
  expect(
    calibrationGate(rows(lowerFailures).map((r) => ({ ...r, observed_repair_failure: false })))
      .eligible,
  ).toBe(false)
  expect(
    calibrationGate(rows(lowerFailures).map((r) => ({ ...r, observed_repair_resolution: false })))
      .eligible,
  ).toBe(false)
  const impossible = rows(lowerFailures).map((r) =>
    r.job.task.family === families[0] ? { ...r, status: 'FAIL' as const } : r,
  )
  expect(
    calibrationGate(impossible).reasons.some((reason) =>
      reason.includes('all valid sessions failed'),
    ),
  ).toBe(true)
  const twoSaturated = rows(sampleSize).map((r, i) => ({
    ...r,
    status: i < 3 ? ('FAIL' as const) : ('PASS' as const),
  }))
  // Retain enough informative families to meet the pooled lower bound while others saturate.
  for (const r of twoSaturated)
    r.status =
      families.slice(0, Math.ceil(families.length / 5) + 1).includes(r.job.task.family) &&
      Number(r.job.id.split('-')[1]) < 8 * families.length
        ? 'FAIL'
        : 'PASS'
  expect(calibrationGate(twoSaturated).eligible).toBe(true)
  expect(
    calibrationGate(twoSaturated.filter((r) => r.job.task.family !== families[0])).eligible,
  ).toBe(false)
})

test('attempt snapshots survive shell exit masking and even source syntax errors; concurrency is capped before scheduling', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dogfood-measurement-'))
  try {
    const repo = path.join(dir, 'repo')
    const task = generateStream()[0]
    if (!task) throw new Error('Missing task')
    await materialize(task, repo)
    const log = path.join(dir, 'attempts.jsonl')
    const env = { PATH: process.env.PATH, OCTONOESIS_DOGFOOD_ATTEMPTS: log }
    const baseline = await command([process.execPath, '--no-env-file', 'test'], repo, env, 10000)
    expect(baseline.code).toBe(1)
    await writeFile(path.join(repo, 'src/subject.ts'), 'export function overlay( { invalid syntax')
    const masked = await command(['bash', '-c', 'bun test 2>&1 | tail -2'], repo, env, 10000)
    expect(masked.code).toBe(0)
    const snapshots = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(snapshots.length).toBe(2)
    expect(snapshots[1].source).toContain('invalid syntax')
    await expect(preregister(dir, { dryRun: true, concurrency: 11 })).rejects.toThrow('cap')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
