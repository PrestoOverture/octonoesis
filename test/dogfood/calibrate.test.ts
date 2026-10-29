import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { command } from '../eval/run'
import { calibrate, preregister, runPool } from './run'
import { families } from './tasks'

test('--calibrate is keyless-testable, uses fresh ledgers and never writes a preregistration', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-calibrate-')))
  try {
    const cli = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'run.ts'),
        '--calibrate',
        '--dry-run',
        '--provider',
        'spark',
        '--per-family',
        '2',
        '--concurrency',
        '3',
        '--output',
        dir,
      ],
      path.resolve(import.meta.dir, '../..'),
      { ...process.env },
      60000,
    )
    expect(cli.code).toBe(0)
    expect(cli.stdout).toContain('hidden pass | public pass | median seconds | median turns')
    expect(cli.stdout).toContain('failed groups:')
    const files = await readdir(dir)
    expect(files).not.toContain('preregistration.json')
    expect(files).not.toContain('stream.json')
    const result = JSON.parse(await readFile(path.join(dir, 'calibration-report.json'), 'utf8'))
    for (const row of Object.values(result.summary) as {
      sessions: number
      hidden_pass_rate: number
      public_pass_rate: number
      median_seconds: number
      median_turns: number
      errors: number
      failed_groups: { id: string; clause_ids: string[]; failures: number; sessions: string[] }[]
      diagnostics_missing: number
    }[]) {
      expect(row.sessions).toBe(2)
      expect(row.hidden_pass_rate).toBe(0.5)
      expect(row.public_pass_rate).toBe(1)
      expect(row.median_seconds).toBeGreaterThan(0)
      expect(row.median_turns).toBe(5)
      expect(row.errors).toBe(0)
      expect(row.diagnostics_missing).toBe(0)
      expect(row.failed_groups.length).toBeGreaterThan(0)
      expect(
        row.failed_groups.every(
          (group) => group.clause_ids.length > 0 && group.sessions.length === group.failures,
        ),
      ).toBe(true)
    }
    const text = await readFile(path.join(dir, 'events.jsonl'), 'utf8')
    const rows = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((e) => e.kind === 'result')
      .map((e) => e.observation)
    expect(rows.length).toBe(2 * families.length)
    expect(rows.every((r) => r.rules_before === 0)).toBe(true)
    expect(new Set(rows.map((r) => r.ledger)).size).toBe(2 * families.length)
    const resumed = await calibrate({ dryRun: true, perFamily: 2, concurrency: 3, output: dir })
    expect(resumed.result).toEqual(result)
    expect(await readFile(path.join(dir, 'events.jsonl'), 'utf8')).toBe(text)
    expect(await readdir(dir)).not.toContain('preregistration.json')
    await expect(preregister(dir, { calibrate: true, dryRun: true })).rejects.toThrow('never')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 90000)

test('worker pool bounds concurrent sessions and drains in-flight work before rejecting', async () => {
  let active = 0
  let maximum = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let ready!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const running = runPool([0, 1, 2, 3], 2, async (item) => {
    active++
    maximum = Math.max(maximum, active)
    if (item === 1) ready()
    await gate
    active--
    if (item === 0) throw new Error('worker failed')
  })
  await started
  expect(active).toBe(2)
  release()
  await expect(running).rejects.toThrow('worker failed')
  expect(maximum).toBe(2)
  expect(active).toBe(0)
})
