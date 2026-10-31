import { expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { command } from '../eval/run'
import { inspectHidden } from './check'
import { families, generateStream, materialize, solutions } from './tasks'

test('retuned families materialize repeatably at stream seeds 4 and 5; starter fails and reference passes', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-retune-')))
  try {
    for (const seed of [4, 5]) {
      for (const family of ['single-flight', 'dependency-plan'] as const) {
        const task = generateStream(families.length, families.length, seed).find(
          (t) => t.family === family,
        )
        if (!task) throw new Error('Missing family')
        const repo = path.join(dir, `${seed}-${family}`)
        const copy = `${repo}-copy`
        await materialize(task, repo)
        await materialize(task, copy)
        for (const file of ['README.md', 'contract.test.ts', 'src/subject.ts'])
          expect(await readFile(path.join(repo, file), 'utf8')).toBe(
            await readFile(path.join(copy, file), 'utf8'),
          )
        expect((await inspectHidden(repo, family, task.seed)).some((g) => !g.passed)).toBe(true)
        await writeFile(path.join(repo, 'src/subject.ts'), solutions[family])
        expect(
          (
            await command(
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
          ).code,
        ).toBe(0)
        expect(
          (
            await command(
              [process.execPath, '--no-env-file', 'test'],
              repo,
              { PATH: process.env.PATH },
              10000,
            )
          ).code,
        ).toBe(0)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

test('cache starter installs pending ownership and recovers from synchronous rejection (train-12/32)', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-cache-root-')))
  try {
    const task = generateStream().find((t) => t.family === 'single-flight')
    if (!task) throw new Error('Missing cache')
    await materialize(task, dir)
    const { Cache } = await import(path.join(dir, 'src/subject.ts'))
    let calls = 0
    let finish!: (value: number) => void
    const cache = new Cache(
      () => {
        calls++
        return new Promise<number>((resolve) => {
          finish = resolve
        })
      },
      5,
      () => 0,
    )
    const a = cache.get('a')
    const b = cache.get('a')
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls).toBe(1)
    finish(7)
    expect(await a).toBe(7)
    expect(await b).toBe(7)
    let tries = 0
    const retry = new Cache(
      () => {
        if (++tries === 1) throw new Error('sync')
        return 9
      },
      5,
      () => 0,
    )
    await expect(retry.get('a')).rejects.toThrow('sync')
    expect(await retry.get('a')).toBe(9)
    expect(tries).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
