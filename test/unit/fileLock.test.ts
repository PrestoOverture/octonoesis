// biome-ignore lint/suspicious/noExplicitAny: Project uses local Bun runtime declarations.
declare const Bun: any
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readEpisodes } from '../../src/memory/episodes/store'
import { rebuildRules } from '../../src/memory/rules/rebuild'
import { loadRule, saveRule } from '../../src/memory/rules/store'
import type { RuleFile } from '../../src/memory/rules/types'
import { recordRuleOutcome } from '../../src/query/engine'
import { LockTimeoutError, RULES_LOCK_OPTIONS, withFileLock } from '../../src/utils/fileLock'

let dir: string
const options = { timeoutMs: 100, staleMs: 600_000 }
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'octonoesis-lock-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const holder = (pid: number, nonce = 'original', acquired_at = Date.now()) =>
  JSON.stringify({ pid, nonce, acquired_at })

it('takes over a dead-pid lock', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'process.exit(0)'])
  await child.exited
  const lock = path.join(dir, 'lock')
  await writeFile(lock, holder(child.pid))
  expect(await withFileLock(lock, () => 42, options)).toBe(42)
  expect(await Bun.file(lock).exists()).toBe(false)
})
it('times out for a live pid with holder information', async () => {
  const lock = path.join(dir, 'lock')
  await writeFile(lock, holder(process.pid))
  try {
    await withFileLock(
      lock,
      () => {
        throw new Error('entered')
      },
      options,
    )
    throw new Error('did not time out')
  } catch (error) {
    expect(error instanceof LockTimeoutError).toBe(true)
    expect((error as LockTimeoutError).holderPid).toBe(process.pid)
  }
})
it('takes over an aged live lock', async () => {
  const lock = path.join(dir, 'lock')
  await writeFile(lock, holder(process.pid, 'old', Date.now() - 700_000))
  expect(await withFileLock(lock, () => true, options)).toBe(true)
})
it('release preserves a replaced nonce, including on callback failure', async () => {
  const lock = path.join(dir, 'lock')
  await expect(
    withFileLock(
      lock,
      async () => {
        await writeFile(lock, holder(process.pid, 'replacement'))
        throw new Error('callback failed')
      },
      options,
    ),
  ).rejects.toThrow('callback failed')
  expect(JSON.parse(await readFile(lock, 'utf8')).nonce).toBe('replacement')
})
function rule(): RuleFile {
  return {
    id: 'rule-shared',
    triggers: { tools: [], command_prefix: [], error_signatures: ['sig'] },
    scope: 'repo',
    alpha: 3,
    beta: 2,
    confidence: 0.6,
    evidence: ['ep_0001'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: '' },
    status: 'pinned',
    user_confirmed: true,
    extractor_version: 'test',
    model_id: 'test',
    prompt_hash: 'test',
    created_at: new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'test',
  }
}
it('does not resurrect a deleted rule for hits or misses', async () => {
  await saveRule(rule(), dir)
  await rm(path.join(dir, 'rule-shared.md'))
  await recordRuleOutcome('rule-shared', false, dir, dir)
  await recordRuleOutcome('rule-shared', true, dir, dir)
  expect(await loadRule('rule-shared', dir)).toBe(null)
})
it('applies only outcome deltas to the fresh disk copy', async () => {
  const current = rule()
  current.hits = 10
  current.alpha = 13
  await saveRule(current, dir)
  await recordRuleOutcome(current.id, false, dir, dir)
  await recordRuleOutcome(current.id, true, dir, dir)
  const saved = await loadRule(current.id, dir)
  expect(saved?.hits).toBe(11)
  expect(saved?.alpha).toBe(14)
  expect(saved?.misses).toBe(1)
  expect(saved?.beta).toBe(3)
  expect(saved?.last_matched_at).not.toBe(null)
})
async function runChildren(mode: string, target: string, count: number): Promise<void> {
  const go = path.join(dir, 'go')
  const children = Array.from({ length: count }, (_, i) =>
    Bun.spawn(
      [
        process.execPath,
        path.resolve('test/fixtures/concurrency/worker.ts'),
        mode,
        target,
        path.join(dir, `ready-${i}`),
        go,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    ),
  )
  try {
    const deadline = Date.now() + 10_000
    while (
      !(
        await Promise.all(children.map((_, i) => Bun.file(path.join(dir, `ready-${i}`)).exists()))
      ).every(Boolean)
    ) {
      if (Date.now() > deadline) throw new Error('Barrier timeout')
      await Bun.sleep(5)
    }
    await writeFile(go, 'go')
    const results = await Promise.all(
      children.map(async (child: { exited: Promise<number>; stderr: ReadableStream }) => ({
        code: await child.exited,
        error: await new Response(child.stderr).text(),
      })),
    )
    for (const result of results) expect(result).toEqual({ code: 0, error: '' })
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    await Promise.all(children.map((child) => child.exited))
  }
}
it('serializes six real processes performing twenty read-increment-write cycles each', async () => {
  const target = path.join(dir, 'count')
  await writeFile(target, '0')
  await runChildren('count', target, 6)
  expect(Number(await readFile(target, 'utf8'))).toBe(120)
})
it('preserves concurrent production hit deltas from two real processes with stale snapshots', async () => {
  const rulesDir = path.join(dir, 'rules')
  await saveRule(rule(), rulesDir)
  await runChildren('hits', rulesDir, 2)
  const saved = await loadRule('rule-shared', rulesDir)
  expect(saved?.hits).toBe(40)
  expect(saved?.alpha).toBe(43)
})

it('concurrent episode hooks preserve every session and allocate unique IDs', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    ts: new Date().toISOString(),
    session_id: `ready-${i}`,
    kind: 'tool',
    tool: 'Bash',
    input_digest: 'test',
    outcome: 'failure',
    error_class: 'TypeError',
    duration_ms: 1,
    fingerprints: [{ coarse: 'sig', medium: 'sig', fine: 'sig' }],
  }))
  await writeFile(
    path.join(dir, 'journal.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  )
  await runChildren('episodes', dir, 6)
  const episodes = await readEpisodes(path.join(dir, 'episodes.jsonl'))
  expect(episodes.length).toBe(6)
  expect(new Set(episodes.map((ep) => ep.session_id)).size).toBe(6)
  expect(episodes.map((ep) => ep.id).sort()).toEqual([
    'ep_0001',
    'ep_0002',
    'ep_0003',
    'ep_0004',
    'ep_0005',
    'ep_0006',
  ])
})

it('dropped accounting warns once per path and returns without throwing', async () => {
  const lock = `${dir}.lock`
  await writeFile(lock, holder(process.pid))
  const timeout = RULES_LOCK_OPTIONS.timeoutMs
  const originalError = console.error
  const warnings: string[] = []
  try {
    RULES_LOCK_OPTIONS.timeoutMs = 20
    console.error = (message: unknown) => {
      warnings.push(String(message))
    }
    await recordRuleOutcome('rule-shared', false, dir, dir)
    await recordRuleOutcome('rule-shared', true, dir, dir)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain(lock)
    expect(warnings[0]).toContain(String(process.pid))
  } finally {
    RULES_LOCK_OPTIONS.timeoutMs = timeout
    console.error = originalError
    await rm(lock, { force: true })
  }
})

it('takes over an empty lock older than the writer grace period', async () => {
  const lock = path.join(dir, 'lock')
  await writeFile(lock, '')
  const old = new Date(Date.now() - 10_000)
  await utimes(lock, old, old)
  let ran = false
  await withFileLock(
    lock,
    () => {
      ran = true
    },
    options,
  )
  expect(ran).toBe(true)
  expect(await Bun.file(lock).exists()).toBe(false)
})
it('respects a fresh empty lock as a writer in progress', async () => {
  const lock = path.join(dir, 'lock')
  await writeFile(lock, '')
  const fresh = new Date()
  await utimes(lock, fresh, fresh)
  let ran = false
  await expect(
    withFileLock(
      lock,
      () => {
        ran = true
      },
      options,
    ),
  ).rejects.toThrow(LockTimeoutError)
  expect(ran).toBe(false)
  expect(await readFile(lock, 'utf8')).toBe('')
})
it('takes over old unparseable or invalid holder payloads', async () => {
  const lock = path.join(dir, 'lock')
  for (const content of [
    '{"pid":',
    'null',
    '{}',
    '{"pid":"bad","acquired_at":"bad","nonce":"n"}',
    '{"pid":0,"acquired_at":0,"nonce":"n"}',
    '{"pid":1,"acquired_at":null,"nonce":"n"}',
  ]) {
    await writeFile(lock, content)
    const old = new Date(Date.now() - 10_000)
    await utimes(lock, old, old)
    expect(await withFileLock(lock, () => 42, options)).toBe(42)
  }
})
it('rebuildRules rejects when a live process holds the rules lock', async () => {
  const rulesDir = path.join(dir, 'rules')
  const lock = `${rulesDir}.lock`
  await writeFile(lock, holder(process.pid))
  const timeout = RULES_LOCK_OPTIONS.timeoutMs
  try {
    RULES_LOCK_OPTIONS.timeoutMs = 20
    await expect(
      rebuildRules(path.join(dir, 'episodes.jsonl'), rulesDir, {
        model: 'test',
        extractorVersion: 'test',
        repoRoot: dir,
      }),
    ).rejects.toThrow(LockTimeoutError)
    expect(JSON.parse(await readFile(lock, 'utf8')).pid).toBe(process.pid)
  } finally {
    RULES_LOCK_OPTIONS.timeoutMs = timeout
  }
})
