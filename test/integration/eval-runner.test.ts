import { expect, test } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  isolatedEnv,
  mockProvider,
  projectRoot,
  providerEnv,
  run,
  tempRoot,
  toolChunk,
} from '../helpers/headless'

const runner = path.join(projectRoot, 'test/eval/run.ts')

test('eval --help works without provider credentials', async () => {
  const root = await tempRoot()
  try {
    const result = await run([process.execPath, '--no-env-file', runner, '--help'], root)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    for (const flag of ['--tasks', '--repeat', '--concurrency', '--model']) {
      expect(result.stdout).toContain(flag)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('eval runs isolated repetitions concurrently, checks fixes, and saves a scorecard', async () => {
  const root = await tempRoot()
  const modelNames: unknown[] = []
  const server = mockProvider((body) => {
    modelNames.push(body.model)
    const messages = body.messages as Array<{ role: string }>
    if (!messages.some((message) => message.role === 'tool')) {
      return [
        toolChunk('Bash', {
          command:
            "test -d .git && test ! -e reference.patch && test ! -e task.json && test ! -e marker && touch marker && sed 's/i <= count/i < count/' src/range.ts > fixed && mv fixed src/range.ts",
        }),
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      ]
    }
    return [
      { choices: [{ index: 0, delta: { content: 'fixed' } }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ]
  })
  try {
    const result = await run(
      [
        process.execPath,
        '--no-env-file',
        runner,
        '--tasks',
        'off-by-one',
        '--repeat',
        '2',
        '--concurrency',
        '2',
        '--model',
        'eval-mock-model',
      ],
      root,
      providerEnv(root, server.port),
    )
    expect(result.code).toBe(0)
    for (const label of [
      'PASS',
      'Turns',
      'Output tokens',
      'Seconds',
      'Tool calls',
      'Exit reason',
    ]) {
      expect(result.stdout).toContain(label)
    }
    const resultsPath = result.stdout.match(/Results: (.+\.json)/)?.[1]
    expect(resultsPath).toBeDefined()
    if (!resultsPath) throw new Error('Missing results path')
    try {
      const report = JSON.parse(await readFile(resultsPath, 'utf8'))
      expect(path.dirname(resultsPath)).toBe(path.join(projectRoot, 'test/eval/results'))
      expect(report.model).toBe('eval-mock-model')
      expect(report.results.length).toBe(2)
      expect(result.stdout).toContain('Summary:')
      expect(report.summary.tasks).toEqual({ 'off-by-one': { pass: 2, fail: 0, error: 0 } })
      expect(report.summary.pass_rate).toBe(1)
      expect(report.summary.median_turns).toBe(2)
      expect(report.summary.median_output_tokens).toBe(6)
      expect(report.summary.median_seconds).toBeGreaterThan(0)
      expect(modelNames).toEqual(Array(4).fill('eval-mock-model'))
      for (const row of report.results) {
        expect(row.task).toBe('off-by-one')
        expect(row.passed).toBe(true)
        expect(row.cli_code).toBe(0)
        expect(row.check.code).toBe(0)
        expect(row.output.turns).toBe(2)
        expect(row.output.usage.output_tokens).toBe(6)
        expect(row.output.tool_calls).toEqual([{ name: 'Bash', ok: true }])
        expect(row.output.exit_reason).toBe('completed')
      }
    } finally {
      await rm(resultsPath, { force: true })
    }
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('eval records failed checks and returns a failing exit status', async () => {
  const root = await tempRoot()
  const server = mockProvider(() => [
    { choices: [{ index: 0, delta: { content: 'No changes.' } }] },
  ])
  try {
    const result = await run(
      [process.execPath, '--no-env-file', runner, '--tasks', 'off-by-one'],
      root,
      providerEnv(root, server.port),
    )
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('FAIL')
    const resultsPath = result.stdout.match(/Results: (.+\.json)/)?.[1]
    if (!resultsPath) throw new Error('Missing results path')
    try {
      const report = JSON.parse(await readFile(resultsPath, 'utf8'))
      expect(report.results[0].passed).toBe(false)
      expect(report.results[0].check.code).not.toBe(0)
      expect(report.results[0].output.exit_reason).toBe('completed')
    } finally {
      await rm(resultsPath, { force: true })
    }
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test('eval validates options before starting any task', async () => {
  const root = await tempRoot()
  try {
    for (const args of [
      ['--repeat', '0'],
      ['--concurrency', '-1'],
      ['--tasks', 'unknown'],
    ]) {
      const result = await run(
        [process.execPath, '--no-env-file', runner, ...args],
        root,
        isolatedEnv(root),
      )
      expect(result.code).toBe(1)
      expect(result.stderr).not.toContain('API_KEY')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
