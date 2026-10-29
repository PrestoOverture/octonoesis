import { expect, test } from 'bun:test'
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isolatedEnv, projectRoot, run, tempRoot } from '../helpers/headless'

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
  'large-file-bug',
  'cross-module-refactor',
  'stack-trace-debug',
  'feature-with-tests',
  'config-parse-edge',
  'chinese-prompt',
  'long-generation',
  'no-op-trap',
  'misleading-stack-trace',
  'async-race',
  'spec-from-tests-only',
  'refactor-preserve-behavior',
]

test('eval catalog contains exactly the twenty contracted fixtures', async () => {
  expect((await readdir(tasksRoot)).sort()).toEqual([...ids].sort())
})

for (const id of ids) {
  test(`${id}: check fails before and passes after its reference patch`, async () => {
    const fixture = path.join(tasksRoot, id)
    const task = JSON.parse(await readFile(path.join(fixture, 'task.json'), 'utf8'))
    expect(typeof task.prompt).toBe('string')
    expect(task.prompt.length).toBeGreaterThan(10)
    expect(typeof task.check).toBe('string')
    expect(task.timeout_s).toBeGreaterThan(0)
    const root = await tempRoot()
    try {
      await cp(path.join(fixture, 'repo'), root, { recursive: true })
      expect((await run(['git', 'init', '-q'], root)).code).toBe(0)
      expect((await run(['git', 'add', '.'], root)).code).toBe(0)
      expect(
        (
          await run(
            [
              'git',
              '-c',
              'user.name=Eval',
              '-c',
              'user.email=eval@localhost',
              'commit',
              '-qm',
              'fixture',
            ],
            root,
          )
        ).code,
      ).toBe(0)
      const env = { ...isolatedEnv(root), EVAL_TASK_DIR: fixture }
      const before = await run(['bash', '-c', task.check], root, env)
      if (id === 'no-op-trap') {
        expect(await readFile(path.join(fixture, 'reference.patch'), 'utf8')).toBe('')
        expect(before.code).toBe(0)
        await writeFile(path.join(root, 'src/clamp.ts'), '// unnecessary edit\n', { flag: 'a' })
        const edited = await run(['bash', '-c', task.check], root, env)
        expect(edited.stderr).toContain('0 fail')
        expect(edited.code).not.toBe(0)
        return
      }
      expect(before.code).not.toBe(0)
      expect(before.stderr).toContain('fail')
      const patch = await run(['git', 'apply', path.join(fixture, 'reference.patch')], root)
      expect(patch.stderr).toBe('')
      expect(patch.code).toBe(0)
      const after = await run(['bash', '-c', task.check], root, env)
      expect(after.code).toBe(0)
      expect(after.stderr).toContain('0 fail')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
