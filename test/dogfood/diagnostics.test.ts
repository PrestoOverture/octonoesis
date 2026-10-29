import { expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { command } from '../eval/run'
import { hiddenGroups, parseHiddenResults } from './check'
import { calibrationSummary, preregister } from './run'
import { errorTolerance, planningPower } from './stats'
import { clauses, families, generateStream, materialize, partialSolution } from './tasks'

async function fixture(
  family: (typeof families)[number],
  source: string,
  work: (repo: string) => Promise<void>,
) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-group-diagnostics-')))
  try {
    const task = generateStream().find((t) => t.family === family)
    if (!task) throw new Error('Missing family')
    await materialize(task, dir)
    await writeFile(path.join(dir, 'src/subject.ts'), source)
    await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('checker preserves failed clause IDs and still measures later independent groups', async () => {
  const source = partialSolution('single-flight').replace(
    'if(!Number.isFinite(ttl)||ttl<=0)',
    'if(false)',
  )
  await fixture('single-flight', source, async (repo) => {
    const result = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'check.ts'),
        repo,
        'single-flight',
        '1002',
      ],
      repo,
      { PATH: process.env.PATH },
      10000,
    )
    expect(result.code).toBe(1)
    const groups = parseHiddenResults(result.stdout)
    expect(groups.length).toBe(hiddenGroups['single-flight'].length)
    expect(groups.find((group) => group.id === 'ttl-rangeerror')?.passed).toBe(false)
    expect(groups.find((group) => group.id === 'pending-invalidation-generations')?.passed).toBe(
      false,
    )
    expect(groups.find((group) => group.id === 'synchronous-rejection-retry')?.passed).toBe(true)
    for (const group of groups)
      for (const id of group.clause_ids)
        expect(
          Object.keys(clauses['single-flight']).map((key) => `single-flight.${key}`),
        ).toContain(id)
    const task = generateStream().find((t) => t.family === 'single-flight')
    if (!task) throw new Error('Missing family')
    const summary = calibrationSummary([
      {
        job: { id: task.id, task, arm: 'train' },
        status: 'FAIL',
        ledger: 'test',
        fingerprints: [],
        hits: 0,
        misses: 0,
        rules_before: 0,
        hidden_groups: groups,
      },
    ])['single-flight']
    expect(
      summary?.failed_groups.find((group) => group.id === 'ttl-rangeerror')?.clause_ids,
    ).toEqual(['single-flight.constructor'])
    expect(summary?.diagnostics_missing).toBe(0)
    const incomplete = calibrationSummary([
      {
        job: { id: task.id, task, arm: 'train' },
        status: 'ERROR',
        ledger: 'test',
        fingerprints: [],
        hits: 0,
        misses: 0,
        rules_before: 0,
        hidden_groups: groups.slice(0, 1),
      },
    ])['single-flight']
    expect(incomplete?.diagnostics_missing).toBe(1)
  })
})

test('wide exact-net group rejects floating-point accumulation missed by the old probe', async () => {
  const source =
    'export function transfer(balances,moves){const out={...balances};for(const x of moves){out[x.from]-=x.amount;out[x.to]+=x.amount}return out}'
  await fixture('atomic-transfer', source, async (repo) => {
    const result = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'check.ts'),
        repo,
        'atomic-transfer',
        '1001',
      ],
      repo,
      { PATH: process.env.PATH },
      10000,
    )
    const wide = parseHiddenResults(result.stdout).find((group) => group.id === 'wide-exact-net')
    expect(wide?.passed).toBe(false)
    expect(wide?.clause_ids).toContain('atomic-transfer.final')
  })
})

test('five-family fixed sample scales coverage and primary planning power without changing inference', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-scaled-plan-')))
  try {
    const plan = await preregister(dir, { provider: 'spark', model: 'test-only-plan' })
    expect(plan.sample_size).toEqual({ training: 40, pairs: 200 })
    expect(plan.jobs.length).toBe(440)
    expect(errorTolerance(plan, []).max_affected_pairs).toBe(10)
    expect(errorTolerance(plan, []).max_training_errors).toBe(2)
    expect(errorTolerance(plan, []).max_arm_count_difference).toBe(1)
    const errors = plan.tasks
      .filter((task) => task.split === 'heldout')
      .slice(0, 11)
      .map((task, i) => {
        const job = plan.jobs.find(
          (job) => job.task.id === task.id && job.arm === (i % 2 ? 'rules-on' : 'rules-off'),
        )
        if (!job) throw new Error('Missing pair arm')
        return {
          job,
          status: 'ERROR' as const,
          ledger: 'synthetic',
          fingerprints: [],
          hits: 0,
          misses: 0,
          rules_before: 0,
        }
      })
    expect(errorTolerance(plan, errors.slice(0, 10)).eligible).toBe(true)
    expect(errorTolerance(plan, errors).eligible).toBe(false)
    for (const family of families) {
      expect(plan.tasks.filter((t) => t.family === family && t.split === 'train').length).toBe(8)
      expect(plan.tasks.filter((t) => t.family === family && t.split === 'heldout').length).toBe(40)
    }
    expect(
      JSON.parse(await readFile(path.join(dir, 'preregistration.json'), 'utf8')).sample_size,
    ).toEqual(plan.sample_size)
    expect(planningPower(plan.sample_size.pairs)).toBeGreaterThan(0.95)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
