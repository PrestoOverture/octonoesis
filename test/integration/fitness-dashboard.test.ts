import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Episode } from '../../src/memory/episodes/types.ts'
import { renderFitnessDashboard } from '../../src/memory/fitness/run.ts'
import { fitnessDashboardSchema } from '../../src/memory/fitness/schema.ts'
import { serializeRule } from '../../src/memory/rules/store.ts'
import type { RuleFile } from '../../src/memory/rules/types.ts'

// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess API is not in the configured TS types
declare const Bun: any

const repoRoot = path.resolve(__dirname, '../..')
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function fingerprint(medium: string) {
  return { coarse: medium.split('|').slice(0, 2).join('|'), medium, fine: `${medium}|detail` }
}

function toolEvent(sessionId: string, ts: string, medium: string) {
  return {
    kind: 'tool',
    schema_version: 1,
    session_id: sessionId,
    ts,
    tool: 'Bash',
    input_digest: 'digest',
    outcome: 'failure',
    error_class: 'TypeError',
    duration_ms: 1,
    fingerprints: [fingerprint(medium)],
  }
}

function episode(overrides: Partial<Episode>): Episode {
  return {
    id: 'ep-default',
    timestamp: '2026-06-01T09:00:00.000Z',
    session_id: 'seed-session',
    task_digest: 'task',
    failure: {
      tool: 'Bash',
      cmd: 'bun test',
      error_class: 'TypeError',
      signature: 'bun-test|TypeError|src/a.ts|detail',
    },
    fix_candidates: [],
    attribution: { status: 'single_direct', confidence: 1 },
    verification: { cmd: 'bun test', exit_code: 0 },
    outcome: 'resolved',
    journal_line_range: { start: 1, end: 2 },
    value_score: 1,
    is_excluded: false,
    exclusion_reason: null,
    ...overrides,
  }
}

function rule(overrides: Partial<RuleFile>): RuleFile {
  return {
    id: 'rule-default',
    triggers: {
      tools: ['Bash'],
      command_prefix: ['bun test'],
      error_signatures: ['bun-test|TypeError|src/a.ts'],
    },
    scope: 'repo',
    alpha: 2,
    beta: 2,
    confidence: 0.5,
    evidence: [],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'src/a.ts' },
    status: 'candidate',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'test-model',
    prompt_hash: 'hash-a',
    created_at: '2026-06-01T00:00:00.000Z',
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'Test advice.',
    ...overrides,
  }
}

function calibration(sessionId: string, ts: string, bucket: string, success: boolean) {
  return {
    session_id: sessionId,
    ts,
    bucket_key: bucket,
    model_id: 'test-model',
    attempt_count: 1,
    first_attempt_success: success,
    user_modifications: 0,
    user_reverts: 0,
    resolved: success,
  }
}

function stats(sessionId: string, ts: string, cost: number, priced = true) {
  return {
    ts,
    session_id: sessionId,
    model: 'test-model',
    turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 },
    cost_usd: cost,
    priced,
    context_utilization: 0.1,
    compact_count: 0,
    duration_ms: 100,
  }
}

async function writeFixture(memoryDir: string): Promise<void> {
  await fs.mkdir(path.join(memoryDir, 'rules'), { recursive: true })
  const mediumA = 'bun-test|TypeError|src/a.ts'
  const mediumB = 'tsc|SyntaxError|src/b.ts'
  const journal = [
    toolEvent('seed-session', '2026-06-01T10:00:00.000Z', mediumA),
    toolEvent('same-session', '2026-06-10T10:00:00.000Z', mediumB),
    toolEvent('cross-session', '2026-06-15T10:00:00.000Z', mediumA),
    {
      kind: 'verify',
      schema_version: 1,
      session_id: 'cross-session',
      ts: '2026-06-15T10:01:00.000Z',
      verdict: 'FAIL',
      fingerprints: [fingerprint(mediumA)],
      command: 'bun test',
      exit_code: 1,
      stale: false,
    },
    {
      kind: 'future_dashboard_signal',
      schema_version: 99,
      session_id: 'future-session',
      ts: '2026-06-22T00:00:00.000Z',
    },
  ]
  await fs.writeFile(
    path.join(memoryDir, 'journal.jsonl'),
    `${journal.map((row) => JSON.stringify(row)).join('\n')}\n`,
  )

  const episodes = [
    episode({}),
    episode({
      id: 'ep-same',
      timestamp: '2026-06-09T09:00:00.000Z',
      session_id: 'same-session',
      failure: {
        tool: 'Bash',
        cmd: 'bun run typecheck',
        error_class: 'SyntaxError',
        signature: `${mediumB}|detail`,
      },
    }),
    episode({
      id: 'ep-unpriced',
      timestamp: '2026-06-11T09:00:00.000Z',
      session_id: 'unpriced-session',
      outcome: 'abandoned',
    }),
    episode({
      id: 'ep-cross',
      timestamp: '2026-06-15T11:00:00.000Z',
      session_id: 'cross-session',
    }),
  ]
  await fs.writeFile(
    path.join(memoryDir, 'episodes.jsonl'),
    `${episodes.map((row) => JSON.stringify(row)).join('\n')}\n`,
  )

  const calibrationRows = [
    calibration('a-1', '2026-06-01T10:00:00.000Z', 'bun-test|TypeError', true),
    calibration('b-1', '2026-06-02T10:00:00.000Z', 'tsc|SyntaxError', false),
    calibration('a-2', '2026-06-08T10:00:00.000Z', 'bun-test|TypeError', false),
    calibration('b-2', '2026-06-09T10:00:00.000Z', 'tsc|SyntaxError', false),
    calibration('a-3', '2026-06-15T10:00:00.000Z', 'bun-test|TypeError', true),
  ]
  await fs.writeFile(
    path.join(memoryDir, 'calibration.jsonl'),
    `${calibrationRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  )

  const statsRows = [
    stats('seed-session', '2026-06-01T12:00:00.000Z', 99),
    stats('same-session', '2026-06-10T12:00:00.000Z', 6),
    stats('unpriced-session', '2026-06-11T12:00:00.000Z', 50, false),
    stats('all-only', '2026-06-11T12:00:00.000Z', 4),
    stats('cross-session', '2026-06-15T12:00:00.000Z', 2),
    stats('seed-session', '2026-06-01T13:00:00.000Z', 12),
  ]
  await fs.writeFile(
    path.join(memoryDir, 'stats.jsonl'),
    `${statsRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  )

  const rules = [
    rule({ id: 'rule-a1', hits: 2, status: 'active', confidence: 0.8 }),
    rule({ id: 'rule-a2', misses: 1, status: 'retired', confidence: 0.2 }),
    rule({ id: 'rule-b1', prompt_hash: 'hash-b', status: 'candidate' }),
  ]
  await Promise.all(
    rules.map((value) =>
      fs.writeFile(path.join(memoryDir, 'rules', `${value.id}.md`), serializeRule(value)),
    ),
  )
}

function keylessEnv(memoryDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ANTHROPIC_API_KEY' && key !== 'OPENAI_API_KEY' && value !== undefined) {
      env[key] = value
    }
  }
  env.OCTONOESIS_MEMORY_DIR = memoryDir
  return env
}

async function runCli(memoryDir: string, args: string[] = []) {
  const proc = Bun.spawn({
    cmd: ['bun', '--no-env-file', 'src/cli.tsx', 'dashboard', ...args],
    cwd: repoRoot,
    env: keylessEnv(memoryDir),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('fitness dashboard CLI', () => {
  it('renders all six sections keylessly and exposes hand-checkable JSON metrics', async () => {
    const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-fitness-cli-'))
    tempDirs.push(memoryDir)
    await writeFixture(memoryDir)

    const cli = await runCli(memoryDir)
    expect(cli.exitCode).toBe(0)
    expect(cli.stderr).toBe('')
    for (let section = 1; section <= 6; section += 1) {
      expect(cli.stdout).toContain(`${section}.`)
    }

    const cliJson = await runCli(memoryDir, [
      '--json',
      '--weeks',
      '999',
      '--bucket',
      'bun-test|TypeError',
    ])
    expect(cliJson.exitCode).toBe(0)
    expect(cliJson.stderr).toBe('')
    const cliReport = fitnessDashboardSchema.parse(JSON.parse(cliJson.stdout))
    expect(cliReport.schema_version).toBe(1)
    expect(cliReport.filters).toEqual({ weeks: 999, bucket: 'bun-test|TypeError' })

    const fixedNow = new Date('2026-07-01T00:00:00.000Z')
    const firstJson = await renderFitnessDashboard({ memoryDir, now: fixedNow, json: true })
    const secondJson = await renderFitnessDashboard({ memoryDir, now: fixedNow, json: true })
    expect(firstJson).toBe(secondJson)
    const report = fitnessDashboardSchema.parse(JSON.parse(firstJson))

    expect(report.ledger_coverage).toEqual({
      journal_first_ts: '2026-06-01T10:00:00.000Z',
      journal_last_ts: '2026-06-15T10:01:00.000Z',
      distinct_session_count: 3,
      journal_line_count: 5,
      episode_count: 4,
      calibration_record_count: 5,
      stats_row_count: 6,
    })
    // Rule accounting: 2 hits / 3 outcomes, dashboard posterior Beta(4,3).
    expect(report.rule_hit_rate_by_prompt_hash[0]?.prompt_hash).toBe('hash-a')
    expect(report.rule_hit_rate_by_prompt_hash[0]?.hit_rate).toBe(2 / 3)
    expect(report.rule_hit_rate_by_prompt_hash[0]?.posterior_mean).toBe(4 / 7)
    // Walk-forward squared errors total 1.27 across five records.
    expect(report.calibration_trend.overall_brier).toBe(0.254)
    expect(report.calibration_trend.weekly.map((row) => row.brier)).toEqual([0.25, 0.26, 0.25])
    // Same-session history is not a repeat; the later cross-session TypeError is.
    expect(report.repeat_failure_rate_trend.map((row) => row.repeats)).toEqual([0, 0, 1])
    expect(report.rule_pool_health.rule_count).toBe(3)
    expect(report.rule_pool_health.cap_relevant_count).toBe(2)
    expect(report.rule_pool_health.never_matched_count).toBe(3)
    // The duplicate seed row is superseded ($99 -> $12); the $50 unpriced row is excluded.
    expect(report.cost_per_resolved_task.unpriced_session_count).toBe(1)
    expect(report.cost_per_resolved_task.weekly.map((row) => row.unit_cost_usd)).toEqual([12, 6, 2])
    expect(report.cost_per_resolved_task.weekly.map((row) => row.all_sessions_cost_usd)).toEqual([
      12, 10, 2,
    ])

    const filtered = fitnessDashboardSchema.parse(
      JSON.parse(
        await renderFitnessDashboard({
          memoryDir,
          now: new Date('2026-06-17T00:00:00.000Z'),
          json: true,
          weeks: 2,
          bucket: 'bun-test|TypeError',
        }),
      ),
    )
    expect(filtered.filters).toEqual({ weeks: 2, bucket: 'bun-test|TypeError' })
    expect(filtered.calibration_trend.weekly.map((row) => row.week)).toEqual([
      '2026-W24',
      '2026-W25',
    ])
    expect(filtered.cost_per_resolved_task.weekly.map((row) => row.unit_cost_usd)).toEqual([
      null,
      2,
    ])
  })

  it('renders honest empty state without creating the missing memory directory', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-fitness-empty-'))
    tempDirs.push(parent)
    const memoryDir = path.join(parent, 'does-not-exist')

    const cli = await runCli(memoryDir)

    expect(cli.exitCode).toBe(0)
    expect(cli.stderr).toBe('')
    expect(cli.stdout.match(/insufficient data/g)?.length).toBe(6)
    let exists = true
    try {
      await fs.stat(memoryDir)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })
})
