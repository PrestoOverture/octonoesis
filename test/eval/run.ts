#!/usr/bin/env bun
import crypto from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Command, InvalidArgumentError } from 'commander'
import type { HeadlessResult } from '../../src/headless'

// biome-ignore lint/suspicious/noExplicitAny: Bun runtime types are not installed in this project
declare const Bun: any

interface Task {
  prompt: string
  check: string
  timeout_s: number
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
  timed_out: boolean
}

interface EvalResult {
  task: string
  repetition: number
  passed: boolean
  cli_code?: number
  cli_stderr?: string
  output?: HeadlessResult
  check?: CommandResult
  duration_ms: number
  error?: string
}

function positiveInteger(value: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new InvalidArgumentError('must be a positive integer')
  }
  return number
}

/** Kill the whole command group so a timed-out shell cannot leave a check running. */
async function command(
  cmd: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  const child = Bun.spawn(cmd, {
    cwd,
    env,
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      // The command may have exited just before its deadline.
    }
  }
  let hardTimeout: ReturnType<typeof setTimeout> | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    kill('SIGTERM')
    hardTimeout = setTimeout(() => kill('SIGKILL'), 3500)
  }, timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code, timed_out: timedOut }
  } finally {
    clearTimeout(timeout)
    if (hardTimeout) clearTimeout(hardTimeout)
  }
}

function parseOutput(stdout: string): HeadlessResult {
  const value = JSON.parse(stdout) as HeadlessResult
  if (
    !value ||
    typeof value.exit_reason !== 'string' ||
    typeof value.turns !== 'number' ||
    typeof value.usage?.output_tokens !== 'number' ||
    typeof value.duration_ms !== 'number' ||
    !Array.isArray(value.tool_calls) ||
    typeof value.final_text !== 'string' ||
    typeof value.session_id !== 'string'
  ) {
    throw new Error('CLI returned an invalid JSON result')
  }
  return value
}

async function evaluate(
  id: string,
  task: Task,
  repetition: number,
  model?: string,
): Promise<EvalResult> {
  const start = performance.now()
  const result: EvalResult = { task: id, repetition, passed: false, duration_ms: 0 }
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'octonoesis-eval-')))
  const repo = path.join(temp, 'repo')
  const env = {
    ...process.env,
    ...(model ? { MODEL: model } : {}),
    OCTONOESIS_REPO_ROOT: repo,
    OCTONOESIS_MEMORY_DIR: path.join(temp, 'memory'),
    OCTONOESIS_DISABLE_MEMORY: '1',
  }
  try {
    await cp(path.join(import.meta.dir, 'tasks', id, 'repo'), repo, { recursive: true })
    for (const args of [
      ['init', '-q'],
      ['add', '.'],
      ['-c', 'user.name=Eval', '-c', 'user.email=eval@localhost', 'commit', '-qm', 'fixture'],
    ]) {
      const git = await command(['git', ...args], repo, env, 10_000)
      if (git.code !== 0 || git.timed_out) throw new Error(`git ${args[0]} failed: ${git.stderr}`)
    }
    const cli = await command(
      [
        process.execPath,
        '--no-env-file',
        path.resolve(import.meta.dir, '../../src/cli.tsx'),
        '--output-format',
        'json',
        '--permission-mode',
        'bypass',
        task.prompt,
      ],
      repo,
      env,
      task.timeout_s * 1000,
    )
    result.cli_code = cli.code
    result.cli_stderr = cli.stderr
    try {
      result.output = parseOutput(cli.stdout)
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }
    if (cli.timed_out) result.error = `CLI timed out after ${task.timeout_s}s`
    // Check even when the agent failed: a partial attempt can still solve a task.
    const checkEnv = { ...env }
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SPARK_API_KEY']) {
      Reflect.deleteProperty(checkEnv, key)
    }
    result.check = await command(['bash', '-c', task.check], repo, checkEnv, task.timeout_s * 1000)
    result.passed = result.check.code === 0 && !result.check.timed_out
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    result.duration_ms = Math.round(performance.now() - start)
    await rm(temp, { recursive: true, force: true })
  }
  return result
}

function scorecard(results: EvalResult[]): string {
  const headers = [
    'Task',
    'Run',
    'Result',
    'Turns',
    'Output tokens',
    'Seconds',
    'Tool calls',
    'Exit reason',
  ]
  const rows = results.map((row) => {
    const counts = new Map<string, number>()
    for (const call of row.output?.tool_calls ?? []) {
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
    }
    return [
      row.task,
      String(row.repetition),
      row.passed ? 'PASS' : 'FAIL',
      String(row.output?.turns ?? '-'),
      String(row.output?.usage.output_tokens ?? '-'),
      ((row.output?.duration_ms ?? row.duration_ms) / 1000).toFixed(2),
      [...counts].map(([name, count]) => `${name}:${count}`).join(',') || '0',
      row.output?.exit_reason ?? (row.error?.includes('timed out') ? 'timeout' : 'cli_error'),
    ]
  })
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  )
  const format = (row: string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')
  return [format(headers), ...rows.map(format)].join('\n')
}

async function main(): Promise<void> {
  const program = new Command()
    .name('bun test/eval/run.ts')
    .description(
      'Run headless coding tasks in disposable git repositories (requires provider credentials).',
    )
    .option('--tasks <id,..>', 'Comma-separated task IDs (default: all)')
    .option('--repeat <n>', 'Repetitions per task', positiveInteger, 1)
    .option('--concurrency <n>', 'Maximum concurrent attempts', positiveInteger, 1)
    .option('--model <m>', 'Override the provider model')
    .parse(process.argv)
  const options = program.opts()
  const tasksRoot = path.join(import.meta.dir, 'tasks')
  const available = (await readdir(tasksRoot)).sort()
  const ids: string[] = options.tasks ? options.tasks.split(',') : available
  if (ids.some((id) => !available.includes(id))) {
    throw new Error(`Unknown task. Available tasks: ${available.join(', ')}`)
  }
  const jobs: { id: string; task: Task; repetition: number }[] = []
  for (const id of ids) {
    const task = JSON.parse(await readFile(path.join(tasksRoot, id, 'task.json'), 'utf8')) as Task
    if (
      typeof task.prompt !== 'string' ||
      typeof task.check !== 'string' ||
      !Number.isFinite(task.timeout_s) ||
      task.timeout_s <= 0
    ) {
      throw new Error(`Invalid task.json for ${id}`)
    }
    for (let repetition = 1; repetition <= options.repeat; repetition++) {
      jobs.push({ id, task, repetition })
    }
  }
  const results: EvalResult[] = new Array(jobs.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const index = next++
        const job = jobs[index]
        if (job) results[index] = await evaluate(job.id, job.task, job.repetition, options.model)
      }
    }),
  )
  const timestamp = new Date().toISOString().replace(/:/g, '-')
  const resultsDir = path.join(import.meta.dir, 'results')
  await mkdir(resultsDir, { recursive: true })
  const resultsPath = path.join(resultsDir, `${timestamp}-${crypto.randomUUID().slice(0, 8)}.json`)
  await writeFile(
    resultsPath,
    `${JSON.stringify({ timestamp, model: options.model ?? process.env.MODEL ?? null, results }, null, 2)}\n`,
  )
  console.log(scorecard(results))
  console.log(`Results: ${resultsPath}`)
  if (results.some((result) => !result.passed)) process.exitCode = 1
}

// This script is invoked explicitly; bun test never imports or executes it.
if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
