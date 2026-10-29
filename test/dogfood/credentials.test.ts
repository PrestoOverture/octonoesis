import { expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { command } from '../eval/run'

const root = path.resolve(import.meta.dir, '../..')
const keys = ['SPARK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const
function keylessEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of keys) Reflect.deleteProperty(env, key)
  return env
}

test('importing the harness preserves live agent credentials while graders remain keyless', async () => {
  const script = `
    const run = await import(${JSON.stringify(path.join(import.meta.dir, 'run.ts'))});
    const keys = ['SPARK_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY'];
    const agent = run.sessionEnvironment('/fixture','/external-ledger',{mode:'live',provider:'spark',model:'test'});
    const dry = run.sessionEnvironment('/fixture','/external-ledger',{mode:'dry-run',provider:'spark',model:'test'});
    const grader = run.verificationEnvironment();
    console.log(JSON.stringify({
      preserved: keys.every(key => process.env[key] === 'fake-dogfood-key'),
      agent: keys.every(key => agent[key] === 'fake-dogfood-key'),
      graders: keys.every(key => !(key in grader)),
      dry: keys.every(key => !(key in dry)),
    }));
  `
  const result = await command(
    [process.execPath, '--no-env-file', '-e', script],
    root,
    {
      ...keylessEnvironment(),
      SPARK_API_KEY: 'fake-dogfood-key',
      OPENAI_API_KEY: 'fake-dogfood-key',
      ANTHROPIC_API_KEY: 'fake-dogfood-key',
    },
    10000,
  )
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    preserved: true,
    agent: true,
    graders: true,
    dry: true,
  })
})

test('missing selected-provider credentials fail before creating outputs or scheduling sessions', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dogfood-missing-key-')))
  try {
    for (const [provider, key] of [
      ['spark', 'SPARK_API_KEY'],
      ['openai', 'OPENAI_API_KEY'],
      ['anthropic', 'ANTHROPIC_API_KEY'],
    ]) {
      for (const mode of ['calibrate', 'experiment']) {
        const env = keylessEnvironment()
        for (const other of keys) if (other !== key) env[other] = 'fake-other-provider-key'
        const result = await command(
          [
            process.execPath,
            '--no-env-file',
            path.join(import.meta.dir, 'run.ts'),
            ...(mode === 'calibrate' ? ['--calibrate', '--per-family', '1'] : ['--model', 'test']),
            '--provider',
            provider as string,
            '--output',
            path.join(dir, `${provider}-${mode}`),
          ],
          root,
          env,
          10000,
        )
        expect(result.code).toBe(1)
        expect(result.stderr).toContain(`${key} is not set`)
        expect(result.stdout).not.toContain('ERROR')
      }
    }
    expect(await readdir(dir)).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60000)

test('pure harness model defaults are pinned to the production defaults without importing providers', async () => {
  const runner = await readFile(path.join(import.meta.dir, 'run.ts'), 'utf8')
  for (const [name, file] of [
    ['DEFAULT_SPARK_MODEL', 'openai.ts'],
    ['DEFAULT_OPENAI_MODEL', 'openai.ts'],
    ['DEFAULT_ANTHROPIC_MODEL', 'anthropic.ts'],
  ]) {
    const source = await readFile(path.join(root, 'src/providers', file as string), 'utf8')
    const pattern = new RegExp(`const ${name} = '([^']+)'`)
    expect(runner.match(pattern)?.[1]).toBe(source.match(pattern)?.[1])
    expect(source.match(pattern)?.[1]).toBeDefined()
  }
})
