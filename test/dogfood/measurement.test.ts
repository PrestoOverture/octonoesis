import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HeadlessResult } from '../../src/headless'
import { command } from '../eval/run'
import { calibrationGate } from './calibration'
import { sessionStatus } from './endpoint'
import type { Observation } from './model'
import { preregister } from './run'
import { families, generateStream, materialize } from './tasks'

const result = { code: 0, stdout: '', stderr: '', timed_out: false }
test('turn exhaustion is task failure; fatal errors, kills and timeouts remain operational', () => {
  const output = { exit_reason: 'max_turns' } as HeadlessResult
  expect(sessionStatus({ ...result, code: 1 }, result, output)).toBe('FAIL')
  expect(sessionStatus({ ...result, code: 1, timed_out: true }, result, output)).toBe('ERROR')
  expect(
    sessionStatus({ ...result, code: 1 }, result, { ...output, exit_reason: 'fatal_error' }),
  ).toBe('ERROR')
  expect(sessionStatus({ ...result, signal: 'SIGTERM' }, result, output)).toBe('ERROR')
  expect(
    sessionStatus(result, { ...result, code: 1 }, { ...output, exit_reason: 'completed' }),
  ).toBe('FAIL')
})

function rows(failures: number): Observation[] {
  return generateStream(30, 1)
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
  expect(calibrationGate(rows(6)).eligible).toBe(true)
  expect(calibrationGate(rows(21)).eligible).toBe(true)
  expect(calibrationGate(rows(5)).eligible).toBe(false)
  expect(calibrationGate(rows(22)).eligible).toBe(false)
  expect(calibrationGate(rows(6).map((r) => ({ ...r, first_attempt: undefined }))).eligible).toBe(
    false,
  )
  expect(
    calibrationGate(rows(6).map((r) => ({ ...r, observed_repair_failure: false }))).eligible,
  ).toBe(false)
  expect(
    calibrationGate(rows(6).map((r) => ({ ...r, observed_repair_resolution: false }))).eligible,
  ).toBe(false)
  const impossible = rows(6).map((r) =>
    r.job.task.family === families[0] ? { ...r, status: 'FAIL' as const } : r,
  )
  expect(
    calibrationGate(impossible).reasons.some((reason) =>
      reason.includes('all valid sessions failed'),
    ),
  ).toBe(true)
  const twoSaturated = rows(30).map((r, i) => ({
    ...r,
    status: i < 3 ? ('FAIL' as const) : ('PASS' as const),
  }))
  // Give each of the three informative families two failures: pooled 6/30.
  for (const r of twoSaturated)
    r.status =
      families.slice(0, 3).includes(r.job.task.family) && Number(r.job.id.split('-')[1]) < 10
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
