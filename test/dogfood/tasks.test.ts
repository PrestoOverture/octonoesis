import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { command } from '../eval/run'
import { inspectHidden } from './check'
import { extraClauses2 } from './extra-tasks2'
import {
  digest,
  families,
  generateStream,
  loadStream,
  materialize,
  partialSolution,
  solutions,
} from './tasks'

test('task stream loads deterministically, recurs across sessions, and separates seeds', () => {
  const stream = loadStream(JSON.parse(JSON.stringify(generateStream())))
  expect(stream.length).toBe(48 * families.length)
  expect(digest(stream)).toBe(digest(generateStream()))
  for (const split of ['train', 'heldout'])
    expect(
      stream
        .filter((t) => t.split === split)
        .every((task, i) => task.family === families[i % families.length]),
    ).toBe(true)
  for (const family of families) {
    expect(stream.filter((t) => t.family === family && t.split === 'train').length).toBe(8)
    expect(stream.filter((t) => t.family === family && t.split === 'heldout').length).toBe(40)
  }
  expect(() => loadStream([])).toThrow()
  expect(() => loadStream([...stream, stream[0]])).toThrow('Duplicate')
  expect(() => loadStream([{ ...stream[0], timeout_s: 0 }, ...stream.slice(1)])).toThrow()
  expect(() =>
    loadStream(stream.map((t) => (t.id === 'heldout-0' ? { ...t, seed: 1000 } : t))),
  ).toThrow('overlap')
})

test('all task families have visible learnable failures and independent hidden discriminators', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-oracles-')))
  try {
    for (const family of families) {
      const task = generateStream().find((t) => t.family === family)
      if (!task) throw new Error('Missing family')
      const repo = path.join(dir, family)
      await materialize(task, repo)
      const visible = await command(
        [process.execPath, '--no-env-file', 'test'],
        repo,
        { PATH: process.env.PATH },
        10000,
      )
      expect(visible.code).toBe(1)
      expect(visible.stderr).toContain('Error')
      if (family in extraClauses2) {
        const starterGroups = await inspectHidden(repo, family, task.seed)
        expect(starterGroups.some((group) => !group.passed)).toBe(true)
      }
      const files = await readdir(repo)
      expect(files.sort()).toEqual(['README.md', 'contract.test.ts', 'src'])
      for (const [label, source] of [
        ['reference', solutions[family]],
        ['partial', partialSolution(family)],
      ] as const) {
        await writeFile(path.join(repo, 'src/subject.ts'), source)
        const publicResult = await command(
          [process.execPath, '--no-env-file', 'test'],
          repo,
          { PATH: process.env.PATH },
          10000,
        )
        expect(publicResult.code).toBe(label === 'reference' ? 0 : 1)
        const hidden = await command(
          [
            process.execPath,
            '--no-env-file',
            path.join(import.meta.dir, 'check.ts'),
            repo,
            family,
            String(task.seed),
          ],
          repo,
          { PATH: process.env.PATH },
          10000,
        )
        expect(hidden.code).toBe(label === 'reference' ? 0 : 1)
      }
      expect(await readdir(repo)).toEqual(files)
      expect(await readFile(path.join(repo, 'contract.test.ts'), 'utf8')).not.toContain('Hidden')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

test('stream seed 2 is deterministic and disjoint from every default training and held-out seed', () => {
  const original = new Set(generateStream().map((task) => task.seed))
  const fresh = generateStream(undefined, undefined, 2)
  expect(fresh).toEqual(generateStream(undefined, undefined, 2))
  expect(fresh.every((task) => !original.has(task.seed))).toBe(true)
  expect(new Set(fresh.map((task) => task.seed)).size).toBe(fresh.length)
  expect(fresh.every((task) => task.seed === task.seed >>> 0)).toBe(true)
  for (const seed of [0, -1, 1.5, 4295, Number.MAX_SAFE_INTEGER])
    expect(() => generateStream(undefined, undefined, seed)).toThrow('Stream seed')
})

test('all families materialize deterministically and replay seeded oracles identically', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-determinism-')))
  try {
    for (const streamSeed of [3, 4, 5])
      for (const family of families) {
        const task = generateStream(families.length, families.length, streamSeed).find(
          (t) => t.family === family && t.split === 'heldout',
        )
        if (!task) throw new Error('Missing variant')
        const a = path.join(dir, `${family}-${streamSeed}-a`)
        const b = path.join(dir, `${family}-${streamSeed}-b`)
        await materialize(task, a)
        await materialize(task, b)
        for (const file of ['README.md', 'contract.test.ts', 'src/subject.ts'])
          expect(await readFile(path.join(a, file), 'utf8')).toBe(
            await readFile(path.join(b, file), 'utf8'),
          )
        if (family in extraClauses2) {
          const starter = await inspectHidden(b, family, task.seed)
          expect(starter.some((g) => !g.passed)).toBe(true)
        }
        await writeFile(path.join(a, 'src/subject.ts'), solutions[family])
        if (family in extraClauses2) {
          const visible = await command(
            [process.execPath, '--no-env-file', 'test'],
            a,
            { PATH: process.env.PATH },
            10000,
          )
          expect(visible.code).toBe(0)
        }
        const first = await inspectHidden(a, family, task.seed)
        expect(first.every((g) => g.passed)).toBe(true)
        expect(await inspectHidden(a, family, task.seed)).toEqual(first)
      }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
