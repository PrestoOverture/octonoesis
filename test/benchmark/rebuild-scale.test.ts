import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendEpisodes, readEpisodes } from '../../src/memory/episodes/store.ts'
import type { Episode } from '../../src/memory/episodes/types.ts'
import { type Fingerprint, assembleFingerprint } from '../../src/memory/fingerprint/extract.ts'
import { findMatchingRules } from '../../src/memory/rules/match.ts'
import { enforcePoolCap, getRuleSpecificity } from '../../src/memory/rules/pool.ts'
import { rebuildRules } from '../../src/memory/rules/rebuild.ts'
import {
  getRulesArchiveDir,
  loadAllRules,
  loadAllRulesIncludingArchived,
  saveRule,
} from '../../src/memory/rules/store.ts'
import type { RuleFile, RuleStatus } from '../../src/memory/rules/types.ts'
import { registerPromptHandler, unregisterPromptHandler } from '../../src/permissions/confirm.ts'
import { setProvider } from '../../src/providers/index.ts'
import type { CanonicalMessage, LLMProvider } from '../../src/providers/types.ts'
import {
  ALL_FIXTURES,
  type FixtureDef,
  SCENARIO_TYPES,
  materializeRepo,
} from '../fixtures/learning-demo/fixtures.ts'

type TestEnv = {
  repoRoot: string
  memoryDir: string
  rulesDir: string
  episodesPath: string
}

type StableRule = Omit<RuleFile, 'created_at' | 'last_rebuilt_at' | 'last_matched_at'>

type SpawnResult = {
  exitCode: number
  stdout: string
  stderr: string
  combined: string
}

type BunSpawn = (options: {
  cmd: string[]
  cwd: string
  stdout: 'pipe'
  stderr: 'pipe'
}) => {
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
}

const COMMAND = 'bun test'
const EXTRACTOR_VERSION = '0.2.0'
const MODEL_ID = 'mock'
// Anchored relative to Date.now() (not a hardcoded calendar date) so this fixture's
// rules and episodes stay fresh forever: src/memory/rules/lifecycle.ts demotes an
// 'active' rule to 'dormant' -- and loadAllRules() drops dormant rules from the hot
// set -- once Date.now() - created_at exceeds 90 days. A fixed absolute BASE_TIME
// (e.g. 2026-06-01) silently crosses that 90-day line as real time passes and takes
// every rule/assertion below down with it. Seven days comfortably represents
// "a pre-existing rule" for the specificity/decay math while staying far inside the
// 90-day dormancy window on every future run, indefinitely.
const BASE_TIME = Date.now() - 7 * 24 * 60 * 60 * 1000
const realSpawn = (globalThis as typeof globalThis & { Bun: { spawn: BunSpawn } }).Bun.spawn

let baseTempDir = ''
let originalMemoryDir: string | undefined
let originalRepoRoot: string | undefined
let originalProvider: string | undefined

function fingerprintFor(
  fixture: FixtureDef,
  expression = fixture.extractorResponse.expression,
): Fingerprint {
  return assembleFingerprint(
    fixture.extractorResponse.tool,
    fixture.extractorResponse.error_class,
    fixture.extractorResponse.file,
    expression,
  )
}

function fixtureForIndex(index: number): FixtureDef {
  const fixture = ALL_FIXTURES[index % ALL_FIXTURES.length] ?? ALL_FIXTURES[0]
  if (!fixture) {
    throw new Error('No fixtures available for rebuild benchmark')
  }
  return fixture
}

function getTextFromMessages(messages: CanonicalMessage[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === 'string') return message.content
      return message.content
        .map((block) => {
          if (block.type === 'text') return block.text
          if (block.type === 'tool_result') return block.content
          return JSON.stringify(block)
        })
        .join('\n')
    })
    .join('\n')
}

function createMockProvider(): LLMProvider {
  return {
    name: 'anthropic',
    createMessageStream: async function* (messages) {
      const text = getTextFromMessages(messages)
      if (!text.includes('distill a reusable coding rule')) {
        throw new Error('Benchmark mock provider only supports distillation prompts')
      }

      const signature = text.match(/Error signature:\s*([^\n]+)/)?.[1]?.trim()
      if (!signature) {
        throw new Error('Distillation prompt did not include an error signature')
      }
      const parts = signature.split('|')
      const anchorFile = parts[2] || fixtureForIndex(0).file

      yield {
        type: 'text_delta',
        text: JSON.stringify({
          slug: `scale-${hashSlug(signature)}`,
          triggers: {
            tools: ['Bash'],
            command_prefix: [COMMAND],
            error_signatures: [signature],
          },
          anchor_file: anchorFile,
          advice: `Scale test advice for ${signature}`,
        }),
      }
      yield { type: 'message_end', usage: { input_tokens: 5, output_tokens: 5 } }
    },
  }
}

function hashSlug(value: string): string {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash.toString(16)
}

function useEnv(env: TestEnv): void {
  process.env.OCTONOESIS_MEMORY_DIR = env.memoryDir
  process.env.OCTONOESIS_REPO_ROOT = env.repoRoot
}

async function createEnv(label: string): Promise<TestEnv> {
  const rawRoot = path.join(baseTempDir, label)
  await rm(rawRoot, { recursive: true, force: true })
  await mkdir(rawRoot, { recursive: true })
  const repoRoot = await realpath(rawRoot)
  const memoryDir = path.join(repoRoot, '.octonoesis')
  const rulesDir = path.join(memoryDir, 'rules')
  await mkdir(memoryDir, { recursive: true })
  await materializeRepo(repoRoot, ALL_FIXTURES)
  return {
    repoRoot,
    memoryDir,
    rulesDir,
    episodesPath: path.join(memoryDir, 'episodes.jsonl'),
  }
}

function fixtureById(id: string): FixtureDef {
  const fixture = ALL_FIXTURES.find((item) => item.id === id)
  if (!fixture) {
    throw new Error(`Missing fixture ${id}`)
  }
  return fixture
}

async function runRealBunTest(env: TestEnv, testFile: string): Promise<SpawnResult> {
  const proc = realSpawn({
    cmd: ['bun', 'test', testFile],
    cwd: env.repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(''),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
  ])
  return { exitCode, stdout, stderr, combined: `${stdout}\n${stderr}` }
}

async function writeFixtureSource(env: TestEnv, fixture: FixtureDef): Promise<void> {
  const target = path.join(env.repoRoot, fixture.file)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, fixture.sourceContent, 'utf8')
}

async function applyFixtureFix(env: TestEnv, fixture: FixtureDef): Promise<void> {
  const target = path.join(env.repoRoot, fixture.file)
  const source = await readFile(target, 'utf8')
  expect(source.includes(fixture.fix.old)).toBe(true)
  await writeFile(target, source.replace(fixture.fix.old, fixture.fix.new), 'utf8')
}

async function writeSmokeTestFile(
  env: TestEnv,
  fixture: FixtureDef,
  content: string,
): Promise<string> {
  const testFile = path.join(env.repoRoot, fixture.file.replace(/\.ts$/, '.test.ts'))
  await mkdir(path.dirname(testFile), { recursive: true })
  await writeFile(testFile, content, 'utf8')
  return path.relative(env.repoRoot, testFile)
}

async function writeEpisodes(env: TestEnv, episodes: Episode[]): Promise<void> {
  useEnv(env)
  await appendEpisodes(episodes)
  expect((await readEpisodes(env.episodesPath)).length).toBe(episodes.length)
}

function generateEpisode(
  index: number,
  fixture: FixtureDef,
  options: {
    uniqueExpression?: string
    excluded?: 'abandoned' | 'unattributable'
    timestampOffset?: number
  } = {},
): Episode {
  const expression = options.uniqueExpression ?? fixture.extractorResponse.expression
  const fp = fingerprintFor(fixture, expression)
  const excluded = options.excluded
  const outcome = excluded === 'abandoned' ? 'abandoned' : 'resolved'
  const attributionStatus = excluded === 'unattributable' ? 'unattributable' : 'single_direct'

  return {
    id: `ep_scale_${String(index).padStart(4, '0')}`,
    timestamp: new Date(BASE_TIME + (options.timestampOffset ?? index) * 60_000).toISOString(),
    session_id: `session-scale-${index}`,
    task_digest: `Scale test episode ${index}`,
    failure: {
      tool: 'Bash',
      cmd: COMMAND,
      error_class: fixture.errorClass,
      signature: fp.fine,
    },
    fix_candidates:
      attributionStatus === 'unattributable'
        ? []
        : [
            {
              tool: 'Edit',
              path: fixture.file,
              summary: `Fix ${fixture.id}`,
              role: 'direct',
            },
          ],
    attribution: {
      status: attributionStatus,
      primary: attributionStatus === 'unattributable' ? undefined : fixture.file,
      confidence: attributionStatus === 'unattributable' ? 0.1 : 0.9,
    },
    verification: outcome === 'resolved' ? { cmd: COMMAND, exit_code: 0 } : undefined,
    outcome,
    journal_line_range: { start: 1, end: 1 },
    value_score: excluded ? 0 : 1,
    is_excluded: Boolean(excluded),
    exclusion_reason: excluded ?? null,
  }
}

function generateEpisodes(count: number, options: { unique?: boolean } = {}): Episode[] {
  return Array.from({ length: count }, (_, index) => {
    const fixture = fixtureForIndex(index)
    return generateEpisode(index, fixture, {
      uniqueExpression: options.unique ? `scale-unique-expr-${index}` : undefined,
    })
  })
}

async function rebuild(env: TestEnv, forceDistill: boolean): Promise<number> {
  useEnv(env)
  const t0 = performance.now()
  await rebuildRules(env.episodesPath, env.rulesDir, {
    model: MODEL_ID,
    extractorVersion: EXTRACTOR_VERSION,
    forceDistill,
  })
  return performance.now() - t0
}

function activeCandidateRules(rules: RuleFile[]): RuleFile[] {
  return rules.filter((rule) => rule.status === 'active' || rule.status === 'candidate')
}

function poolScore(rule: RuleFile): number {
  const specificity = getRuleSpecificity(rule)
  const createdTime = new Date(rule.created_at).getTime()
  const daysSinceCreation = Math.max(0, (Date.now() - createdTime) / (24 * 60 * 60 * 1000))
  return specificity * rule.confidence * Math.exp(-0.01 * daysSinceCreation)
}

function makeRule(
  fixture: FixtureDef,
  overrides: Partial<RuleFile> & { status?: RuleStatus } = {},
): RuleFile {
  const fp = fingerprintFor(fixture)
  const hits = overrides.hits ?? 0
  const misses = overrides.misses ?? 0
  const evidence = overrides.evidence ?? ['existing-episode']
  const alpha = overrides.alpha ?? 2 + hits + evidence.length
  const beta = overrides.beta ?? 2 + misses

  return {
    id: overrides.id ?? `rule-existing-${hashSlug(fp.fine)}`,
    triggers: overrides.triggers ?? {
      tools: ['Bash'],
      command_prefix: [COMMAND],
      error_signatures: [fp.fine],
    },
    scope: overrides.scope ?? 'repo',
    alpha,
    beta,
    confidence: overrides.confidence ?? Number((alpha / (alpha + beta)).toFixed(4)),
    evidence,
    hits,
    misses,
    challenged_by: overrides.challenged_by ?? [],
    anchor: overrides.anchor ?? { file: fixture.file },
    status: overrides.status ?? 'candidate',
    user_confirmed: overrides.user_confirmed ?? false,
    extractor_version: overrides.extractor_version ?? EXTRACTOR_VERSION,
    model_id: overrides.model_id ?? MODEL_ID,
    prompt_hash: overrides.prompt_hash ?? 'benchmark',
    created_at: overrides.created_at ?? new Date(BASE_TIME).toISOString(),
    last_matched_at: overrides.last_matched_at ?? null,
    last_rebuilt_at: overrides.last_rebuilt_at ?? null,
    advice: overrides.advice ?? `Existing advice for ${fixture.id}`,
  }
}

function stableRules(rules: RuleFile[]): StableRule[] {
  return rules
    .map(({ created_at, last_rebuilt_at, last_matched_at, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id))
}

let rebuild100Ms = 0
let rebuild500Ms = 0
let poolActiveCandidateCount = 0
let poolTotalCount = 0
let maxMatchMs = 0

beforeAll(async () => {
  originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  originalRepoRoot = process.env.OCTONOESIS_REPO_ROOT
  originalProvider = process.env.LLM_PROVIDER
  baseTempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'octonoesis-rebuild-scale-')))
  registerPromptHandler(async () => 'allow_once')
  setProvider(createMockProvider())
})

afterAll(async () => {
  setProvider(null)
  unregisterPromptHandler()
  process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  process.env.OCTONOESIS_REPO_ROOT = originalRepoRoot
  process.env.LLM_PROVIDER = originalProvider
  if (baseTempDir) {
    await rm(baseTempDir, { recursive: true, force: true })
  }
})

describe('Step 19.6 - Rebuild Scale Benchmark', () => {
  it('sub-test 1: rebuilds 100 episodes within PRD NFR', async () => {
    const env = await createEnv('prd-100')
    await writeEpisodes(env, generateEpisodes(100))

    rebuild100Ms = await rebuild(env, true)
    const rules = await loadAllRules(env.rulesDir)

    expect(rebuild100Ms < 60_000).toBe(true)
    expect(rules.length).toBeGreaterThan(0)
  })

  it('sub-test 2: rebuilds 500 mixed episodes from eligible records only', async () => {
    const env = await createEnv('large-500')
    const episodes = Array.from({ length: 500 }, (_, index) => {
      const fixture = fixtureForIndex(index)
      if (index < 350) {
        return generateEpisode(index, fixture, { uniqueExpression: `large-eligible-${index}` })
      }
      if (index < 450) {
        return generateEpisode(index, fixture, {
          uniqueExpression: `large-abandoned-${index}`,
          excluded: 'abandoned',
        })
      }
      return generateEpisode(index, fixture, {
        uniqueExpression: `large-unattributable-${index}`,
        excluded: 'unattributable',
      })
    })
    await writeEpisodes(env, episodes)

    rebuild500Ms = await rebuild(env, true)
    // Phase 40: the hot dir is capped at 150 active/candidate; cap-evicted (retired)
    // rules live under archive/. The merged view proves nothing was lost.
    const hotRules = await loadAllRules(env.rulesDir)
    const rules = await loadAllRulesIncludingArchived(env.rulesDir)

    expect(hotRules.length).toBe(150)
    expect(rules.length).toBe(350)
    expect(rules.every((rule) => rule.evidence.length === 1)).toBe(true)
  })

  it('sub-test 3: enforces pool cap while archiving evicted rules on disk', async () => {
    const env = await createEnv('pool-cap')
    await writeEpisodes(env, generateEpisodes(500, { unique: true }))

    await rebuild(env, true)
    // Phase 40: evicted (retired) rules are archived, never deleted -- the merged
    // hot+archive view carries the full pool; the hot dir holds exactly the cap.
    const rules = await loadAllRulesIncludingArchived(env.rulesDir)
    const hotFiles = await readdir(env.rulesDir)
    const archiveFiles = await readdir(getRulesArchiveDir(env.rulesDir))
    const activeCandidate = activeCandidateRules(rules)
    const retired = rules.filter((rule) => rule.status === 'retired')

    poolActiveCandidateCount = activeCandidate.length
    poolTotalCount = rules.length

    const isRuleFile = (file: string) => file.startsWith('rule-') && file.endsWith('.md')
    const hotRuleFileCount = hotFiles.filter(isRuleFile).length
    const archiveRuleFileCount = archiveFiles.filter(isRuleFile).length

    expect(activeCandidate.length).toBe(150)
    expect(hotRuleFileCount).toBe(150)
    expect(archiveRuleFileCount).toBeGreaterThan(0)
    expect(hotRuleFileCount + archiveRuleFileCount).toBe(rules.length)
    expect(retired.length).toBeGreaterThan(0)

    const maxRetiredScore = Math.max(...retired.map(poolScore))
    const minSurvivorScore = Math.min(...activeCandidate.map(poolScore))
    expect(maxRetiredScore <= minSurvivorScore).toBe(true)

    const directResult = enforcePoolCap(rules.map((rule) => ({ ...rule })))
    expect(activeCandidateRules(directResult).length).toBe(150)
  })

  it('sub-test 4: keeps matching budget and latency under scale', async () => {
    const fixture = fixtureForIndex(0)
    const fp = fingerprintFor(fixture)
    const rules: RuleFile[] = Array.from({ length: 150 }, (_, index) =>
      makeRule(fixture, {
        id: `rule-match-${index}`,
        status: 'candidate',
        triggers: {
          tools: ['Bash'],
          command_prefix: [COMMAND],
          error_signatures: index < 50 ? [fp.fine] : index < 100 ? [fp.medium] : [fp.coarse],
        },
      }),
    )

    const fingerprints: Fingerprint[] = Array.from({ length: 50 }, (_, index) => {
      const base = fingerprintFor(fixtureForIndex(index))
      return {
        ...base,
        fine: fp.fine,
        medium: fp.medium,
        coarse: fp.coarse,
      }
    })

    for (const fingerprint of fingerprints) {
      const t0 = performance.now()
      const matches = findMatchingRules([fingerprint], rules)
      const elapsed = performance.now() - t0
      maxMatchMs = Math.max(maxMatchMs, elapsed)

      expect(matches.length).toBe(2)
      expect(elapsed < 50).toBe(true)
      expect(matches.every((match) => match.level === 'fine')).toBe(true)
    }
  })

  it('sub-test 5: preserves rule state through non-forced rebuild', async () => {
    const env = await createEnv('state-preservation')
    const historyFixture = fixtureForIndex(0)
    const pinnedFixture = fixtureForIndex(1)
    const bannedFixture = fixtureForIndex(2)
    const adviceFixture = fixtureForIndex(3)
    const alphaFixture = fixtureForIndex(4)
    const fixtures = [historyFixture, pinnedFixture, bannedFixture, adviceFixture, alphaFixture]
    const rules = [
      makeRule(historyFixture, { id: 'rule-state-history', hits: 5, misses: 2 }),
      makeRule(pinnedFixture, { id: 'rule-state-pinned', status: 'pinned' }),
      makeRule(bannedFixture, { id: 'rule-state-banned', status: 'banned' }),
      makeRule(adviceFixture, {
        id: 'rule-state-advice',
        advice: 'Custom advice text that should survive rebuild',
      }),
      makeRule(alphaFixture, { id: 'rule-state-alpha', hits: 17, misses: 1, alpha: 20, beta: 3 }),
    ]
    const episodes = fixtures.map((fixture, index) => generateEpisode(index, fixture))

    useEnv(env)
    for (const rule of rules) {
      await saveRule(rule, env.rulesDir)
    }
    await writeEpisodes(env, episodes)

    await rebuild(env, false)
    const rebuilt = await loadAllRules(env.rulesDir)
    const byId = new Map(rebuilt.map((rule) => [rule.id, rule]))

    expect(byId.get('rule-state-history')?.hits).toBe(5)
    expect(byId.get('rule-state-history')?.misses).toBe(2)
    expect(byId.get('rule-state-pinned')?.status).toBe('pinned')
    expect(byId.get('rule-state-banned')?.status).toBe('banned')
    expect(byId.get('rule-state-advice')?.advice).toBe(
      'Custom advice text that should survive rebuild',
    )
    expect((byId.get('rule-state-alpha')?.alpha ?? 0) >= 20).toBe(true)
    expect(byId.get('rule-state-alpha')?.beta).toBe(3)
  })

  it('sub-test 6: rebuild is idempotent over stable fields', async () => {
    const env = await createEnv('idempotency')
    await writeEpisodes(env, generateEpisodes(20, { unique: true }))

    await rebuild(env, true)
    const first = stableRules(await loadAllRules(env.rulesDir))

    await rebuild(env, false)
    const second = stableRules(await loadAllRules(env.rulesDir))

    expect(new Set(second.map((rule) => rule.id)).size).toBe(second.length)
    expect(second).toEqual(first)
  })

  it('sub-test 7: real-spawn smoke validates fixture mock data', async () => {
    const env = await createEnv('real-spawn')
    const cases = [
      {
        fixture: fixtureById('NullAccess_A1'),
        errorPattern: /TypeError/,
        testFileContent: `import { describe, it } from 'bun:test'
import { displayUser } from './user'

describe('displayUser', () => {
  it('handles missing user', () => {
    displayUser(null as any)
  })
})
`,
      },
      {
        fixture: fixtureById('ParseError_A1'),
        errorPattern:
          /SyntaxError|Unexpected end of file|Expected "}"|Expected .* but found end of file/,
        testFileContent: `import { describe, expect, it } from 'bun:test'
import { parsePayload } from './parser'

describe('parsePayload', () => {
  it('rejects malformed JSON', () => {
    const result = parsePayload('not-json')
    expect(result).toBeDefined()
  })
})
`,
      },
      {
        fixture: fixtureById('ModuleNotFound_A1'),
        errorPattern: /ImportError|Could not resolve|Cannot find module/,
        beforeRun: async () => {
          await writeFile(
            path.join(env.repoRoot, 'src/config.ts'),
            'export function loadConfig(raw: string): string {\n  return raw\n}\n',
            'utf8',
          )
        },
        testFileContent: `import { describe, expect, it } from 'bun:test'
import { loadFromDisk } from './loader'

describe('loadFromDisk', () => {
  it('loads config from disk', () => {
    expect(loadFromDisk).toBeDefined()
  })
})
`,
      },
    ]

    for (const { fixture, errorPattern, beforeRun, testFileContent } of cases) {
      await writeFixtureSource(env, fixture)
      if (beforeRun) {
        await beforeRun()
      }
      const testFile = await writeSmokeTestFile(env, fixture, testFileContent)

      const failed = await runRealBunTest(env, testFile)
      expect(failed.exitCode).not.toBe(0)
      expect(errorPattern.test(failed.stderr)).toBe(true)
      expect(failed.stderr).toContain(path.basename(fixture.file))
      expect(failed.stderr.toLowerCase()).toContain('fail')

      await applyFixtureFix(env, fixture)
      const passed = await runRealBunTest(env, testFile)
      expect(passed.exitCode).toBe(0)
      expect(passed.combined.toLowerCase()).toContain('pass')
    }
  })

  it('reports benchmark summary metrics', () => {
    expect(rebuild100Ms).toBeGreaterThan(0)
    expect(rebuild500Ms).toBeGreaterThan(0)
    expect(poolActiveCandidateCount).toBe(150)
    expect(poolTotalCount).toBeGreaterThan(150)
    expect(maxMatchMs < 50).toBe(true)
  })
})
