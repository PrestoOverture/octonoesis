import { expect, test } from 'bun:test'
import { cp, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { projectRoot, run, tempRoot } from '../helpers/headless'

const tasksRoot = path.join(projectRoot, 'test/eval/tasks')
const ids = [
  'off-by-one',
  'null-handling',
  'async-await',
  'wrong-regex',
  'sorting-comparator',
  'missing-export',
  'multi-file-rename',
  'small-feature',
]

test('eval catalog contains exactly the eight contracted fixtures', async () => {
  expect((await readdir(tasksRoot)).sort()).toEqual([...ids].sort())
})

for (const id of ids) {
  test(`${id}: check fails before and passes after its reference patch`, async () => {
    const fixture = path.join(tasksRoot, id)
    const task = JSON.parse(await readFile(path.join(fixture, 'task.json'), 'utf8'))
    expect(typeof task.prompt).toBe('string')
    expect(task.prompt.length).toBeGreaterThan(10)
    expect(task.check).toBe('bun test')
    expect(task.timeout_s).toBeGreaterThan(0)
    const root = await tempRoot()
    try {
      await cp(path.join(fixture, 'repo'), root, { recursive: true })
      expect((await run(['git', 'init', '-q'], root)).code).toBe(0)
      const before = await run(['bash', '-c', task.check], root)
      expect(before.code).not.toBe(0)
      expect(before.stderr).toContain('fail')
      const patch = await run(['git', 'apply', path.join(fixture, 'reference.patch')], root)
      expect(patch.stderr).toBe('')
      expect(patch.code).toBe(0)
      const after = await run(['bash', '-c', task.check], root)
      expect(after.code).toBe(0)
      expect(after.stderr).toContain('0 fail')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
