import { expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { command } from '../eval/run'
import { GROUP_TIMEOUT_MS, hiddenGroups, parseHiddenResults } from './check'
import { calibrationSummary, checkStatus, preregister } from './run'
import { errorTolerance, planningPower } from './stats'
import { clauses, families, generateStream, materialize, partialSolution, solutions } from './tasks'

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

test('a never-settling repair fails its deadline group with clauses and later groups still run', async () => {
  // Ignoring invalidation keeps the old pending promise: this reproduces train-17.
  const source = solutions['single-flight'].replace(
    'invalidate(key){this.entries.delete(key);}',
    'invalidate(key){}',
  )
  await fixture('single-flight', source, async (repo) => {
    const result = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'check.ts'),
        repo,
        'single-flight',
        '1017',
      ],
      repo,
      { PATH: process.env.PATH },
      30000,
    )
    expect(result.timed_out).toBe(false)
    expect(result.code).toBe(1)
    expect(checkStatus(result)).toBe('FAIL')
    const groups = parseHiddenResults(result.stdout)
    expect(groups.length).toBe(hiddenGroups['single-flight'].length)
    const pending = groups.find((group) => group.id === 'pending-invalidation-generations')
    expect(pending?.passed).toBe(false)
    expect(pending?.message).toContain(`exceeded ${GROUP_TIMEOUT_MS}ms`)
    expect(pending?.clause_ids).toEqual([
      'single-flight.pending',
      'single-flight.expiry',
      'single-flight.invalidation',
    ])
    expect(groups.find((group) => group.id === 'synchronous-rejection-retry')?.passed).toBe(true)
  })
}, 30000)

test('oracle-internal exceptions and missing grader input are ERROR, not task failures', async () => {
  await fixture('single-flight', solutions['single-flight'], async (repo) => {
    const checker = path.join(repo, 'crashing-check.ts')
    const source = (await readFile(path.join(import.meta.dir, 'check.ts'), 'utf8'))
      .replace("from './tasks'", `from ${JSON.stringify(path.join(import.meta.dir, 'tasks.ts'))}`)
      .replace(
        'group.run(m, random, controller.signal)',
        "(() => { throw new Error('oracle regression sentinel') })()",
      )
    await writeFile(checker, source)
    const result = await command(
      [process.execPath, '--no-env-file', checker, repo, 'single-flight', '1017'],
      repo,
      { PATH: process.env.PATH },
      10000,
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('oracle regression sentinel')
    expect(checkStatus(result)).toBe('ERROR')
    expect(parseHiddenResults(result.stdout)).toEqual([])
    const missing = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'check.ts'),
        path.join(repo, 'missing'),
        'single-flight',
        '1017',
      ],
      repo,
      { PATH: process.env.PATH },
      10000,
    )
    expect(missing.code).toBe(2)
    expect(checkStatus(missing)).toBe('ERROR')
    await expect(command([path.join(repo, 'missing-executable')], repo, {}, 1000)).rejects.toThrow()
    // A load error in submitted code is not a crash in the grader itself.
    await writeFile(path.join(repo, 'src/subject.ts'), 'export class Cache { invalid syntax')
    const invalid = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'check.ts'),
        repo,
        'single-flight',
        '1018',
      ],
      repo,
      { PATH: process.env.PATH },
      10000,
    )
    expect(invalid.code).toBe(1)
    expect(checkStatus(invalid)).toBe('FAIL')
  })
})

test('outer verifier timeouts grade submitted code FAIL; unexpected kills and grader crashes are ERROR', () => {
  const timeout = { code: 143, stdout: '', stderr: '', timed_out: true, signal: 'SIGTERM' }
  // The same helper classifies first-repair replays and final hidden/public checks.
  expect(checkStatus(timeout)).toBe('FAIL')
  expect(checkStatus({ ...timeout, timed_out: false })).toBe('ERROR')
  expect(checkStatus({ ...timeout, code: 2, timed_out: false, signal: null })).toBe('ERROR')
})

test('a cached rejection on retry is a task FAIL even when its Error originated in the oracle loader', async () => {
  const source = solutions['single-flight'].replace(
    'error=>{if(this.entries.get(key)===e)this.entries.delete(key);throw error;}',
    'error=>{throw error;}',
  )
  expect(source).not.toBe(solutions['single-flight'])
  await fixture('single-flight', source, async (repo) => {
    const result = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'check.ts'),
        repo,
        'single-flight',
        '1017',
      ],
      repo,
      { PATH: process.env.PATH },
      10000,
    )
    expect(result.code).toBe(1)
    expect(checkStatus(result)).toBe('FAIL')
    const groups = parseHiddenResults(result.stdout)
    expect(groups.length).toBe(hiddenGroups['single-flight'].length)
    expect(groups.find((group) => group.id === 'synchronous-rejection-retry')?.passed).toBe(false)
  })
})
