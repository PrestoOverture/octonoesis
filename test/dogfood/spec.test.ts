import { expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { command } from '../eval/run'
import { assertSpecCoverage, hiddenGroups } from './check'
import { clauses, families, generateStream, materialize, solutions, specifications } from './tasks'

test('every hidden assertion group maps to explicit prompt and README clauses', async () => {
  assertSpecCoverage()
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-spec-')))
  try {
    for (const family of families) {
      const task = generateStream().find((t) => t.family === family)
      if (!task) throw new Error('Missing family')
      const repo = path.join(dir, family)
      await materialize(task, repo)
      const readme = await readFile(path.join(repo, 'README.md'), 'utf8')
      for (const group of hiddenGroups[family])
        for (const clause of group.requires) {
          expect(task.prompt).toContain(clause)
          expect(readme).toContain(clause)
        }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('coverage rejects the old unstated TTL RangeError requirement', () => {
  const oldSpec = specifications['single-flight'].replace(
    clauses['single-flight'].constructor,
    'new Cache(loader, ttl, now) uses a positive finite ttl and an injected clock function.',
  )
  expect(() => assertSpecCoverage({ ...specifications, 'single-flight': oldSpec })).toThrow(
    'ttl-rangeerror',
  )
})

test('session budget covers the observed live durations and difficult atomic cases are public', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-difficulty-')))
  try {
    for (const task of generateStream(6, 1).filter((t) => t.family === 'atomic-transfer')) {
      expect(task.timeout_s).toBe(900)
      const repo = path.join(dir, task.id)
      await materialize(task, repo)
      const source = await readFile(path.join(repo, 'contract.test.ts'), 'utf8')
      expect(source).toContain('__proto__')
      expect(source).toContain('assert.throws')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a compliant cache may start its loader after multiple microtasks', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-scheduling-')))
  try {
    const task = generateStream().find((t) => t.family === 'single-flight')
    if (!task) throw new Error('Missing cache task')
    await materialize(task, dir)
    const delayed = solutions['single-flight'].replace(
      'Promise.resolve().then(()=>this.loader(key))',
      'Promise.resolve().then(()=>Promise.resolve()).then(()=>this.loader(key))',
    )
    await writeFile(path.join(dir, 'src/subject.ts'), delayed)
    const result = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'check.ts'),
        dir,
        task.family,
        String(task.seed),
      ],
      dir,
      { PATH: process.env.PATH },
      10000,
    )
    expect(result.code).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('public and hidden checks accept a specified null-prototype transfer result', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-null-prototype-')))
  try {
    const task = generateStream().find((t) => t.family === 'atomic-transfer')
    if (!task) throw new Error('Missing transfer task')
    await materialize(task, dir)
    await writeFile(
      path.join(dir, 'src/subject.ts'),
      solutions['atomic-transfer'].replace('const out={};', 'const out=Object.create(null);'),
    )
    const publicResult = await command(
      [process.execPath, '--no-env-file', 'test'],
      dir,
      { PATH: process.env.PATH },
      10000,
    )
    expect(publicResult.code).toBe(0)
    const hiddenResult = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'check.ts'),
        dir,
        task.family,
        String(task.seed),
      ],
      dir,
      { PATH: process.env.PATH },
      10000,
    )
    expect(hiddenResult.code).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
