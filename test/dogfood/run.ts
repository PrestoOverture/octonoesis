#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { isKnownJournalEvent, parseJournalEvent } from '../../src/memory/events'
import { loadAllRulesIncludingArchived } from '../../src/memory/rules/store'
import { classify, command, parseOutput } from '../eval/run'
import type { Job, Observation, Plan } from './model'
import { markdown, report } from './stats'
import { digest, families, generateStream, loadStream, materialize } from './tasks'

// Keep imports credential-neutral: src/providers captures and scrubs process.env keys.
// credentials.test.ts pins these pure copies to the production defaults.
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_OPENAI_MODEL = 'gpt-5-nano'
const DEFAULT_SPARK_MODEL = 'spark-x2.6'

export const projectRoot = path.resolve(import.meta.dir, '../..')
export interface Options {
  output?: string
  dryRun?: boolean
  provider?: string
  model?: string
  concurrency?: number
  calibrate?: boolean
  perFamily?: number
}
type Event =
  | { kind: 'started'; job: Job; ledger: string; plan_hash: string }
  | { kind: 'result'; observation: Observation }
  | { kind: 'recovered-tail'; fragment_hash: string }

function positiveInteger(value: string | number): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Expected a positive integer')
  return number
}

function requireProviderCredential(options: Options): void {
  if (options.dryRun) return
  const keys: Record<string, string> = {
    spark: 'SPARK_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
  }
  const key = keys[options.provider ?? 'spark']
  if (!key) throw new Error('Unsupported provider')
  if (!process.env[key]?.trim())
    throw new Error(`${key} is not set. Export it before starting a live dogfood run.`)
}

/** Public/hidden graders and fixture setup never receive provider credentials. */
export function verificationEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, TMPDIR: os.tmpdir() }
}

async function jsonFile(file: string, value: unknown): Promise<void> {
  const handle = await open(file, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function appendEvent(dir: string, event: Event): Promise<void> {
  const handle = await open(path.join(dir, 'events.jsonl'), 'a')
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Canonicalize even a not-yet-created destination, so symlinks cannot bypass isolation. */
async function canonicalFuture(input: string): Promise<string> {
  try {
    return await realpath(input)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(input)
    if (parent === input) throw error
    return path.join(await canonicalFuture(parent), path.basename(input))
  }
}
export async function assertIsolatedOutput(input: string): Promise<string> {
  const dir = await canonicalFuture(path.resolve(input))
  const root = await realpath(projectRoot)
  if (
    dir === root ||
    dir.startsWith(root + path.sep) ||
    dir.split(path.sep).includes('.octonoesis')
  )
    throw new Error(
      'Output and ledger must be outside the repository and every .octonoesis directory',
    )
  return dir
}

/** Hash executable sources, not git dirtiness: a resume cannot silently change its methods. */
async function sourceHash(): Promise<string> {
  const files: string[] = []
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'docs') continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(file)
    }
  }
  await visit(path.join(projectRoot, 'src'))
  await visit(import.meta.dir)
  files.push(path.join(projectRoot, 'test/eval/run.ts'))
  files.push(path.join(projectRoot, 'package.json'), path.join(projectRoot, 'bun.lock'))
  const hash = createHash('sha256')
  for (const file of files.sort())
    hash.update(path.relative(projectRoot, file)).update(await readFile(file))
  return hash.digest('hex')
}

export async function preregister(dir: string, options: Options): Promise<Plan> {
  if (options.calibrate) throw new Error('Calibration must never create a preregistration')
  const file = path.join(dir, 'preregistration.json')
  const mode = options.dryRun ? 'dry-run' : 'live'
  const provider = options.provider ?? 'spark'
  const model = options.dryRun ? 'scripted-provider-v1' : options.model
  if (!model) throw new Error('Live runs require --model to pin the provider model')
  if (!['spark', 'openai', 'anthropic'].includes(provider)) throw new Error('Unsupported provider')
  const concurrency = positiveInteger(options.concurrency ?? 1)
  const hash = await sourceHash()
  try {
    const plan = JSON.parse(await readFile(file, 'utf8')) as Plan
    if (
      plan.evaluation_concurrency !== concurrency ||
      plan.mode !== mode ||
      plan.provider !== provider ||
      plan.model !== model ||
      plan.source_hash !== hash ||
      digest(loadStream(plan.tasks)) !== plan.stream_hash
    )
      throw new Error('Resume configuration/source/stream differs from immutable preregistration')
    return plan
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if ((await readdir(dir)).some((name) => name !== '.run-lock'))
    throw new Error('New output directory must be empty')
  const tasks = loadStream(generateStream(options.dryRun ? 6 : 24, options.dryRun ? 12 : 120))
  const jobs: Job[] = tasks
    .filter((t) => t.split === 'train')
    .map((task) => ({ id: task.id, task, arm: 'train' }))
  for (const task of tasks.filter((t) => t.split === 'heldout')) {
    const arms =
      Number.parseInt(digest(task.id).slice(0, 8), 16) % 2 === 0
        ? (['rules-on', 'rules-off'] as const)
        : (['rules-off', 'rules-on'] as const)
    for (const arm of arms) jobs.push({ id: `${task.id}-${arm}`, task, arm })
  }
  const plan: Plan = {
    version: 1,
    mode,
    provider,
    model,
    registered_at: new Date().toISOString(),
    source_hash: hash,
    stream_hash: digest(tasks),
    tasks,
    jobs,
    hypothesis:
      'Rules learned in sequential training sessions improve first-submission hidden-check success on paired held-out variants.',
    metrics: {
      primary: 'paired first-submission success (one headless session, local retries allowed)',
      repeat_failure:
        'fraction of held-out sessions with a production coarse fingerprint observed during training',
      turns_tokens: 'mean headless turns and input+output tokens by arm (fork overhead excluded)',
      rule_hit_rate:
        'production rule hit deltas / (hit + miss deltas); undefined without accounted outcomes',
    },
    test: 'Two-sided exact McNemar alpha .05 on complete matched task pairs; risk difference on minus off; conservative 95% Bonferroni-Wilson CI. ERROR counts as failure in primary analysis. Sensitivity drops all ERROR-containing pairs; confirmation requires both analyses significant in the same direction. Operational tolerance: at most 5% of planned evaluation pairs affected, arm error counts differing by at most one, and at most 5% training errors. Secondary metrics descriptive only.',
    sample_size: {
      training: tasks.filter((t) => t.split === 'train').length,
      pairs: tasks.filter((t) => t.split === 'heldout').length,
    },
    stopping_rule:
      'Run all planned jobs exactly once. Training stays sequential; evaluation uses the registered concurrency with hashed within-pair order. No efficacy peeking, no early success or sample extension. Resume skips committed jobs; an interrupted started job becomes ERROR, never rerun. Final inference only after fixed sample; calibration failure, operational tolerance exceeded, or sensitivity disagreement => inconclusive.',
    evaluation_concurrency: concurrency,
    error_tolerance: {
      max_pair_fraction: 0.05,
      max_arm_count_difference: 1,
      max_training_fraction: 0.05,
    },
    calibration: { min_failure_rate: 0.1, max_failure_rate: 0.9, min_recurring_sessions: 2 },
  }
  // Both artifacts are durable before the first session is scheduled.
  await jsonFile(path.join(dir, 'stream.json'), tasks)
  await jsonFile(file, plan)
  return plan
}

type SessionConfig = Pick<Plan, 'mode' | 'provider' | 'model'>

export function sessionEnvironment(
  repo: string,
  ledger: string,
  plan: SessionConfig,
): NodeJS.ProcessEnv {
  // Explicitly exclude inherited experiment/memory switches that would change the treatment.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OCTONOESIS_REPO_ROOT: repo,
    OCTONOESIS_MEMORY_DIR: ledger,
    LLM_PROVIDER: plan.provider,
    MODEL: plan.model,
  }
  for (const key of Object.keys(env))
    if (
      key.startsWith('OCTONOESIS_') &&
      !['OCTONOESIS_REPO_ROOT', 'OCTONOESIS_MEMORY_DIR'].includes(key)
    )
      Reflect.deleteProperty(env, key)
  for (const key of ['SPARK_MODEL', 'OPENAI_MODEL', 'ANTHROPIC_MODEL'])
    Reflect.deleteProperty(env, key)
  if (plan.provider === 'spark') env.SPARK_MODEL = plan.model
  if (plan.mode === 'dry-run') {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SPARK_API_KEY'])
      Reflect.deleteProperty(env, key)
    // Mock has no auto-memory sub-provider; main query, verifier and distillation stay real.
    env.OCTONOESIS_FORK_DEPTH = '1'
  }
  return env
}

async function runSession(
  dir: string,
  job: Job,
  plan: SessionConfig,
  ledger: string,
  measurePublic = false,
): Promise<Observation> {
  const start = performance.now()
  const workspace = path.join(dir, 'sessions', job.id)
  const repo = path.join(workspace, 'repo')
  await mkdir(workspace, { recursive: true })
  await jsonFile(path.join(workspace, 'task.json'), job.task)
  await materialize(job.task, repo)
  if (measurePublic) {
    const source = (await readFile(path.join(repo, 'contract.test.ts'), 'utf8')).replace(
      "'./src/subject'",
      JSON.stringify(path.join(repo, 'src/subject.ts')),
    )
    await writeFile(path.join(workspace, 'public.test.ts'), source, { flag: 'wx' })
  }
  const env = sessionEnvironment(repo, ledger, plan)
  const before = await loadAllRulesIncludingArchived(path.join(ledger, 'rules'))
  const row: Observation = {
    job,
    status: 'ERROR',
    fingerprints: [],
    hits: 0,
    misses: 0,
    rules_before: before.filter((r) => ['active', 'candidate', 'pinned'].includes(r.status)).length,
    ledger,
  }
  try {
    for (const args of [
      ['init', '-q'],
      ['add', '.'],
      ['-c', 'user.name=Dogfood', '-c', 'user.email=dogfood@localhost', 'commit', '-qm', 'fixture'],
    ]) {
      const git = await command(['git', ...args], repo, verificationEnvironment(), 10000)
      if (git.code !== 0 || git.timed_out) throw new Error(`git ${args[0]} failed: ${git.stderr}`)
    }
    const args =
      plan.mode === 'dry-run'
        ? [path.join(import.meta.dir, 'mock.ts'), JSON.stringify(job.task)]
        : [
            path.join(projectRoot, 'src/cli.tsx'),
            '--output-format',
            'json',
            '--permission-mode',
            'bypass',
            job.task.prompt,
          ]
    const cli = await command(
      [process.execPath, '--no-env-file', ...args],
      repo,
      env,
      job.task.timeout_s * 1000,
    )
    await jsonFile(path.join(workspace, 'cli.json'), cli)
    try {
      row.output = parseOutput(cli.stdout)
    } catch {
      row.error = 'Missing/invalid headless JSON'
    }
    if (measurePublic) {
      const publicResult = await command(
        [process.execPath, '--no-env-file', 'test', path.join(workspace, 'public.test.ts')],
        repo,
        verificationEnvironment(),
        30000,
      )
      await jsonFile(path.join(workspace, 'public.json'), publicResult)
      row.public_status =
        publicResult.timed_out || publicResult.signal || publicResult.code > 1
          ? 'ERROR'
          : publicResult.code === 0
            ? 'PASS'
            : 'FAIL'
    }
    // This child is started after the agent exits. No oracle path, source or env is passed to it.
    const check = await command(
      [
        process.execPath,
        '--no-env-file',
        path.join(import.meta.dir, 'check.ts'),
        repo,
        job.task.family,
        String(job.task.seed),
      ],
      repo,
      verificationEnvironment(),
      30000,
    )
    await jsonFile(path.join(workspace, 'check.json'), check)
    row.status = classify(cli, check, Boolean(row.output), row.output?.exit_reason)
    if (
      cli.timed_out ||
      cli.code !== 0 ||
      !row.output ||
      row.output.exit_reason !== 'completed' ||
      check.timed_out ||
      check.signal ||
      check.code > 1
    ) {
      row.status = 'ERROR'
      row.error ??= `Session/check operational failure (CLI ${cli.code}, check ${check.code})`
    }
    const text = await readFile(path.join(ledger, 'journal.jsonl'), 'utf8')
    const fingerprints = new Set<string>()
    for (const line of text.trim().split('\n')) {
      const event = parseJournalEvent(JSON.parse(line))
      if (!event || !isKnownJournalEvent(event) || event.session_id !== row.output?.session_id)
        continue
      if (event.kind === 'tool' || event.kind === 'verify')
        for (const fp of event.fingerprints ?? [])
          if (typeof fp.coarse === 'string') fingerprints.add(fp.coarse)
    }
    row.fingerprints = [...fingerprints].sort()
    const after = await loadAllRulesIncludingArchived(path.join(ledger, 'rules'))
    for (const rule of after) {
      const prev = before.find((r) => r.id === rule.id)
      row.hits += Math.max(0, rule.hits - (prev?.hits ?? 0))
      row.misses += Math.max(0, rule.misses - (prev?.misses ?? 0))
    }
    if (/Memory.*(off|unusable)|Journal.*(fail|lost)/i.test(cli.stderr)) {
      row.status = 'ERROR'
      row.error = 'Learning ledger unavailable (see cli.json)'
    }
  } catch (error) {
    row.status = 'ERROR'
    row.error = String(error)
  }
  row.duration_ms = Math.round(performance.now() - start)
  return row
}

async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const file = path.join(dir, '.run-lock')
  try {
    await writeFile(file, String(process.pid), { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const pid = Number(await readFile(file, 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error('Invalid run lock; inspect before removing')
    try {
      process.kill(pid, 0)
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'ESRCH') {
        await rm(file)
        return acquireLock(dir)
      }
      throw probe
    }
    throw new Error(`Run already active (pid ${pid})`)
  }
  return () => rm(file, { force: true })
}

async function readEvents(dir: string): Promise<Event[]> {
  let text: string
  try {
    text = await readFile(path.join(dir, 'events.jsonl'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (text && !text.endsWith('\n')) {
    const tail = text.slice(text.lastIndexOf('\n') + 1)
    let suffix = '\n'
    try {
      JSON.parse(tail)
    } catch {
      suffix += `${JSON.stringify({ kind: 'recovered-tail', fragment_hash: digest(tail) })}\n`
    }
    // Retain original bytes and explicitly audit the fragment; never truncate the log.
    const handle = await open(path.join(dir, 'events.jsonl'), 'a')
    try {
      await handle.writeFile(suffix)
      await handle.sync()
    } finally {
      await handle.close()
    }
    text += suffix
  }
  const lines = text.split('\n').filter(Boolean)
  const events: Event[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i] as string) as Event)
    } catch (error) {
      const recovery = JSON.parse(lines[i + 1] ?? 'null') as Event | null
      if (recovery?.kind !== 'recovered-tail' || recovery.fragment_hash !== digest(lines[i]))
        throw error
    }
  }
  return events
}

/** Bound independent work, drain in-flight workers on failure before releasing the run lock. */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  positiveInteger(concurrency)
  let next = 0
  let failed = false
  let failure: unknown
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!failed) {
        const index = next++
        if (index >= items.length) return
        try {
          await work(items[index] as T)
        } catch (error) {
          failed = true
          failure = error
        }
      }
    }),
  )
  if (failed) throw failure
}

function eventWriter(dir: string): (event: Event) => Promise<void> {
  let pending = Promise.resolve()
  return (event) => {
    pending = pending.then(() => appendEvent(dir, event))
    return pending
  }
}

async function resumeRows(dir: string, hash: string, jobs: Job[]): Promise<Observation[]> {
  const events = await readEvents(dir)
  for (const event of events) {
    if (event.kind === 'recovered-tail') continue
    const job = event.kind === 'started' ? event.job : event.observation.job
    if (JSON.stringify(jobs.find((j) => j.id === job.id)) !== JSON.stringify(job))
      throw new Error('Event does not match scheduled job')
    if (event.kind === 'started' && event.plan_hash !== hash)
      throw new Error('Preregistration/configuration changed after scheduling')
  }
  const rows = events.flatMap((e) => (e.kind === 'result' ? [e.observation] : []))
  const completed = new Set(rows.map((r) => r.job.id))
  if (completed.size !== rows.length) throw new Error('Duplicate result in append-only output')
  for (const event of events)
    if (event.kind === 'started' && !completed.has(event.job.id)) {
      const row: Observation = {
        job: event.job,
        status: 'ERROR',
        fingerprints: [],
        hits: 0,
        misses: 0,
        rules_before: 0,
        error: 'Interrupted session; retained as error, no retry',
        ledger: '',
      }
      await appendEvent(dir, { kind: 'result', observation: row })
      rows.push(row)
      completed.add(event.job.id)
    }
  return rows
}

async function performJob(
  dir: string,
  job: Job,
  config: SessionConfig,
  hash: string,
  emit: (event: Event) => Promise<void>,
  previousLedger?: string,
  measurePublic = false,
): Promise<Observation> {
  const ledger = path.join(dir, 'ledgers', job.id)
  await emit({ kind: 'started', job, ledger, plan_hash: hash })
  let row: Observation
  try {
    if (previousLedger)
      await cp(previousLedger, ledger, { recursive: true, errorOnExist: true, force: false })
    else await mkdir(ledger, { recursive: true })
    if (job.arm === 'rules-off')
      await rm(path.join(ledger, 'rules'), { recursive: true, force: true })
    row = await runSession(dir, job, config, ledger, measurePublic)
  } catch (error) {
    row = {
      job,
      status: 'ERROR',
      fingerprints: [],
      hits: 0,
      misses: 0,
      rules_before: 0,
      ledger: '',
      error: String(error),
    }
  }
  await emit({ kind: 'result', observation: row })
  return row
}

export async function run(
  options: Options,
): Promise<{ dir: string; result: ReturnType<typeof report> }> {
  if (options.calibrate || options.perFamily !== undefined)
    throw new Error('Use --calibrate for calibration options')
  requireProviderCredential(options)
  const dir = await assertIsolatedOutput(
    options.output ?? (await mkdtemp(path.join(os.tmpdir(), 'octonoesis-dogfood-'))),
  )
  await mkdir(dir, { recursive: true })
  const unlock = await acquireLock(dir)
  try {
    const plan = await preregister(dir, options)
    const rows = await resumeRows(dir, digest(plan), plan.jobs)
    const emit = eventWriter(dir)
    const empty = path.join(dir, 'ledgers', 'empty')
    await mkdir(empty, { recursive: true })
    let trained = empty
    // The training lineage always has exactly one writer, independent of --concurrency.
    for (const job of plan.jobs.filter((j) => j.arm === 'train')) {
      const previous = rows.find((r) => r.job.id === job.id)
      const row = previous ?? (await performJob(dir, job, plan, digest(plan), emit, trained))
      if (!previous) {
        rows.push(row)
        console.log(`${rows.length}/${plan.jobs.length} ${job.id}: ${row.status}`)
      }
      if (row.ledger) trained = row.ledger
    }
    const pairs = plan.tasks
      .filter((t) => t.split === 'heldout')
      .map((task) => plan.jobs.filter((j) => j.task.id === task.id))
    await runPool(pairs, plan.evaluation_concurrency, async (pair) => {
      // A worker runs a whole pair in its registered hashed order. Other pairs are independent.
      for (const job of pair) {
        if (rows.some((r) => r.job.id === job.id)) continue
        const row = await performJob(dir, job, plan, digest(plan), emit, trained)
        rows.push(row)
        console.log(`${rows.length}/${plan.jobs.length} ${job.id}: ${row.status}`)
      }
    })
    // Completion events are keyed by job; analysis and reports always use plan order.
    rows.sort(
      (a, b) =>
        plan.jobs.findIndex((j) => j.id === a.job.id) -
        plan.jobs.findIndex((j) => j.id === b.job.id),
    )
    const result = report(plan, rows)
    // Immutable reports are materialized once; resume verifies them instead of overwriting.
    for (const [name, content] of [
      ['report.json', `${JSON.stringify(result, null, 2)}\n`],
      ['report.md', markdown(result)],
    ]) {
      const file = path.join(dir, name as string)
      try {
        await writeFile(file, content as string, { flag: 'wx' })
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await readFile(file, 'utf8')) !== content
        )
          throw error
      }
    }
    return { dir, result }
  } finally {
    await unlock()
  }
}

interface CalibrationConfig extends SessionConfig {
  source_hash: string
  per_family: number
  concurrency: number
  jobs: Job[]
}

export function calibrationSummary(rows: Observation[]) {
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    if (!sorted.length) return null
    return (
      ((sorted[Math.floor((sorted.length - 1) / 2)] as number) +
        (sorted[Math.floor(sorted.length / 2)] as number)) /
      2
    )
  }
  return Object.fromEntries(
    families.map((family) => {
      const group = rows.filter((r) => r.job.task.family === family)
      const hidden = group.filter((r) => r.status === 'PASS').length
      const publicPass = group.filter((r) => r.public_status === 'PASS').length
      return [
        family,
        {
          sessions: group.length,
          hidden_passes: hidden,
          hidden_pass_rate: group.length ? hidden / group.length : null,
          public_passes: publicPass,
          public_pass_rate: group.length ? publicPass / group.length : null,
          errors: group.filter((r) => r.status === 'ERROR').length,
          public_errors: group.filter((r) => r.public_status === 'ERROR').length,
          median_seconds: median(
            group.flatMap((r) =>
              r.output
                ? [r.output.duration_ms / 1000]
                : r.duration_ms === undefined
                  ? []
                  : [r.duration_ms / 1000],
            ),
          ),
          median_turns: median(group.flatMap((r) => (r.output ? [r.output.turns] : []))),
          target_failure_rate: [0.2, 0.7],
          within_target:
            group.length > 0 &&
            1 - hidden / group.length >= 0.2 &&
            1 - hidden / group.length <= 0.7,
        },
      ]
    }),
  )
}

export async function calibrate(options: Options) {
  requireProviderCredential(options)
  const dir = await assertIsolatedOutput(
    options.output ?? (await mkdtemp(path.join(os.tmpdir(), 'octonoesis-calibration-'))),
  )
  await mkdir(dir, { recursive: true })
  const unlock = await acquireLock(dir)
  try {
    const provider = options.provider ?? 'spark'
    if (!['spark', 'openai', 'anthropic'].includes(provider))
      throw new Error('Unsupported provider')
    const perFamily = positiveInteger(options.perFamily ?? 3)
    const concurrency = positiveInteger(options.concurrency ?? 1)
    const tasks = generateStream(families.length * perFamily, 1).filter((t) => t.split === 'train')
    const config: CalibrationConfig = {
      mode: options.dryRun ? 'dry-run' : 'live',
      provider,
      model: options.dryRun
        ? 'scripted-provider-v1'
        : (options.model ??
          (provider === 'spark'
            ? DEFAULT_SPARK_MODEL
            : provider === 'openai'
              ? DEFAULT_OPENAI_MODEL
              : DEFAULT_ANTHROPIC_MODEL)),
      per_family: perFamily,
      concurrency,
      source_hash: await sourceHash(),
      jobs: tasks.map((task) => ({ id: task.id, task, arm: 'train' })),
    }
    const file = path.join(dir, 'calibration.json')
    try {
      const existing = JSON.parse(await readFile(file, 'utf8')) as CalibrationConfig
      if (digest(existing) !== digest(config))
        throw new Error('Calibration configuration/source differs from existing run')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if ((await readdir(dir)).some((name) => name !== '.run-lock'))
        throw new Error('New calibration output directory must be empty')
      // Descriptive run configuration only: no hypothesis/test, registry entry, or preregistration.
      await jsonFile(file, config)
    }
    const rows = await resumeRows(dir, digest(config), config.jobs)
    const emit = eventWriter(dir)
    await runPool(config.jobs, concurrency, async (job) => {
      if (rows.some((r) => r.job.id === job.id)) return
      const row = await performJob(dir, job, config, digest(config), emit, undefined, true)
      rows.push(row)
    })
    rows.sort(
      (a, b) =>
        config.jobs.findIndex((j) => j.id === a.job.id) -
        config.jobs.findIndex((j) => j.id === b.job.id),
    )
    const summary = calibrationSummary(rows)
    const result = { mode: config.mode, provider, model: config.model, summary }
    const reportFile = path.join(dir, 'calibration-report.json')
    try {
      await jsonFile(reportFile, result)
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readFile(reportFile, 'utf8')) !== `${JSON.stringify(result, null, 2)}\n`
      )
        throw error
    }
    console.log('Family | hidden pass | public pass | median seconds | median turns | errors')
    for (const [family, row] of Object.entries(summary))
      console.log(
        `${family} | ${row.hidden_pass_rate} | ${row.public_pass_rate} | ${row.median_seconds} | ${row.median_turns} | ${row.errors}`,
      )
    return { dir, result }
  } finally {
    await unlock()
  }
}

if (import.meta.main) {
  const program = new Command()
    .name('bun test/dogfood/run.ts')
    .option('--dry-run', 'Use scripted keyless provider through real query/tools/learning hooks')
    .option('--output <dir>', 'External persistent output directory; reuse to resume')
    .option('--provider <name>', 'spark, openai, or anthropic', 'spark')
    .option('--model <name>', 'Pin the live provider model')
    .option(
      '--concurrency <N>',
      'Evaluation pair workers, or fresh-ledger calibration workers',
      positiveInteger,
      1,
    )
    .option('--calibrate', 'Descriptive fresh-ledger probe; never writes a preregistration')
    .option('--per-family <K>', 'Calibration sessions per family', positiveInteger)
    .parse(process.argv)
  const options = program.opts<Options>()
  const execution = options.calibrate
    ? calibrate(options).then(({ dir }) => console.log(`Calibration output: ${dir}`))
    : run(options).then(({ dir, result }) =>
        console.log(`Verdict: ${result.verdict}\nOutput: ${dir}`),
      )
  execution.catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
}
