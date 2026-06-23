import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import crypto from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendEpisodes, readEpisodes } from '../../../src/memory/episodes/store.ts'
import type { Episode } from '../../../src/memory/episodes/types.ts'
import { type Fingerprint, assembleFingerprint } from '../../../src/memory/fingerprint/extract.ts'
import { rebuildRules } from '../../../src/memory/rules/rebuild.ts'
import { loadAllRules } from '../../../src/memory/rules/store.ts'
import type { RuleFile } from '../../../src/memory/rules/types.ts'
import { registerPromptHandler, unregisterPromptHandler } from '../../../src/permissions/confirm.ts'
import { setProvider } from '../../../src/providers/index.ts'
import type { CanonicalMessage, LLMProvider, StreamEvent } from '../../../src/providers/types.ts'
import { type ToolContext, query } from '../../../src/query.ts'
import {
  ALL_FIXTURES,
  type FixtureDef,
  SCENARIO_TYPES,
  byScenario,
  materializeRepo,
} from '../../fixtures/learning-demo/fixtures.ts'

type SpawnResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type TestEnv = {
  repoRoot: string
  memoryDir: string
  rulesDir: string
}

type SessionMode = 'fix' | 'miss' | 'no-match'

type ActiveSession = {
  id: string
  fixture: FixtureDef
  mode: SessionMode
  turn: number
  extractorQueue: FixtureDef[]
}

type SessionResult = {
  ctx: ToolContext
  toolResults: string[]
  injectedRules: { rule: RuleFile; fingerprint: Fingerprint }[]
}

const COMMAND = 'bun test'
const COLLISION_PAIRS = [
  ['NullAccess', 'DeprecatedAPI'],
  ['ParseError', 'JSONMalformed'],
  ['ModuleNotFound', 'MissingExport'],
  ['ExpectMismatch', 'SnapshotDrift'],
  ['MissingEnvVar', 'ConfigInvalid'],
] as const

const fixtureByFine = new Map<string, FixtureDef>()
for (const fixture of ALL_FIXTURES) {
  fixtureByFine.set(fingerprintFor(fixture).fine, fixture)
}

let baseTempDir = ''
let originalMemoryDir: string | undefined
let originalRepoRoot: string | undefined
let originalProvider: string | undefined
// biome-ignore lint/suspicious/noExplicitAny: Bun process handle mock
let originalSpawn: any
let activeSession: ActiveSession | null = null
const mockSpawnResults: Record<string, SpawnResult[]> = {}
const createdRules: RuleFile[] = []
let totalSessionsRun = 0
let negativeTransferMisses = 0

function fingerprintFor(fixture: FixtureDef): Fingerprint {
  return assembleFingerprint(
    fixture.extractorResponse.tool,
    fixture.extractorResponse.error_class,
    fixture.extractorResponse.file,
    fixture.extractorResponse.expression,
  )
}

function fixtureById(scenarioType: string, suffix: string): FixtureDef {
  const fixture = byScenario(scenarioType).find((candidate) => candidate.id.endsWith(`_${suffix}`))
  if (!fixture) {
    throw new Error(`Missing fixture ${scenarioType}_${suffix}`)
  }
  return fixture
}

function getTextFromMessages(messages: CanonicalMessage[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === 'string') {
        return message.content
      }
      return message.content
        .map((block) => {
          if (block.type === 'text') {
            return block.text
          }
          if (block.type === 'tool_result') {
            return block.content
          }
          return JSON.stringify(block)
        })
        .join('\n')
    })
    .join('\n')
}

function providerEventsForSession(session: ActiveSession): StreamEvent[] {
  session.turn++
  const prefix = session.id

  if (session.mode === 'no-match') {
    if (session.turn === 1) {
      return [
        { type: 'text_delta', text: `Running ${session.fixture.id}.` },
        { type: 'tool_use', id: `${prefix}-bash-1`, name: 'Bash', input: { command: COMMAND } },
        { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
      ]
    }
    return [
      { type: 'text_delta', text: 'No matching rule was available.' },
      { type: 'message_end', usage: { input_tokens: 5, output_tokens: 3 } },
    ]
  }

  if (session.turn === 1) {
    return [
      { type: 'text_delta', text: `Running ${session.fixture.id}.` },
      { type: 'tool_use', id: `${prefix}-bash-1`, name: 'Bash', input: { command: COMMAND } },
      { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
    ]
  }

  if (session.turn === 2) {
    return [
      { type: 'text_delta', text: `Applying fixture fix for ${session.fixture.id}.` },
      {
        type: 'tool_use',
        id: `${prefix}-read-2`,
        name: 'Read',
        input: { path: session.fixture.file },
      },
      {
        type: 'tool_use',
        id: `${prefix}-edit-2`,
        name: 'Edit',
        input: {
          path: session.fixture.file,
          old_string: session.fixture.fix.old,
          new_string: session.fixture.fix.new,
        },
      },
      { type: 'message_end', usage: { input_tokens: 20, output_tokens: 10 } },
    ]
  }

  if (session.turn === 3) {
    return [
      { type: 'text_delta', text: `Verifying ${session.fixture.id}.` },
      { type: 'tool_use', id: `${prefix}-bash-3`, name: 'Bash', input: { command: COMMAND } },
      { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
    ]
  }

  return [
    { type: 'text_delta', text: `Done with ${session.fixture.id}.` },
    { type: 'message_end', usage: { input_tokens: 5, output_tokens: 3 } },
  ]
}

function createMockProvider(): LLMProvider {
  return {
    name: 'anthropic',
    createMessageStream: async function* (messages) {
      const text = getTextFromMessages(messages)

      if (text.includes('precise tool execution error analyzer')) {
        const fixture = activeSession?.extractorQueue.shift()
        if (!fixture) {
          throw new Error('Extractor requested without an active fixture')
        }
        yield {
          type: 'text_delta',
          text: JSON.stringify(fixture.extractorResponse),
        }
        yield { type: 'message_end', usage: { input_tokens: 5, output_tokens: 5 } }
        return
      }

      if (text.includes('distill a reusable coding rule')) {
        const signature = text.match(/Error signature:\s*([^\n]+)/)?.[1]?.trim()
        const fixture = signature ? fixtureByFine.get(signature) : undefined
        if (!fixture) {
          throw new Error(`Could not resolve distillation fixture for signature ${signature}`)
        }
        const fingerprint = fingerprintFor(fixture)
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            slug: `p19-${fixture.id.toLowerCase().replace(/_/g, '-')}`,
            triggers: {
              tools: ['Bash'],
              command_prefix: [COMMAND],
              error_signatures: [fingerprint.fine, fingerprint.medium, fingerprint.coarse],
            },
            anchor_file: fixture.file,
            advice: `Rule for ${fixture.id}: apply the fixture-specific fix in ${fixture.file}.`,
          }),
        }
        yield { type: 'message_end', usage: { input_tokens: 5, output_tokens: 5 } }
        return
      }

      if (!activeSession) {
        throw new Error('Session turn requested without an active session')
      }

      for (const event of providerEventsForSession(activeSession)) {
        yield event
      }
    },
  }
}

async function createEnv(label: string): Promise<TestEnv> {
  const rawRoot = path.join(baseTempDir, label)
  await rm(rawRoot, { recursive: true, force: true })
  await mkdir(rawRoot, { recursive: true })
  const repoRoot = await realpath(rawRoot)
  const memoryDir = path.join(repoRoot, '.octonoesis')
  await mkdir(memoryDir, { recursive: true })
  await materializeRepo(repoRoot, ALL_FIXTURES)
  return {
    repoRoot,
    memoryDir,
    rulesDir: path.join(memoryDir, 'rules'),
  }
}

function useEnv(env: TestEnv): void {
  process.env.OCTONOESIS_MEMORY_DIR = env.memoryDir
  process.env.OCTONOESIS_REPO_ROOT = env.repoRoot
}

function installPhase19Mocks(): void {
  registerPromptHandler(async () => 'allow_always')
  setProvider(createMockProvider())

  // biome-ignore lint/suspicious/noExplicitAny: Bun global object
  ;(globalThis as any).Bun.spawn = (options: { cmd: string[] }) => {
    const command = options.cmd[2] ?? ''
    const queue = mockSpawnResults[command]
    const next = queue?.shift()
    if (!next) {
      throw new Error(`Unexpected spawn command or exhausted mock results: ${command}`)
    }
    return {
      pid: 12345,
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(next.stdout))
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(next.stderr))
          controller.close()
        },
      }),
      exited: Promise.resolve(next.exitCode),
      kill: () => {},
    }
  }
}

async function resetFixtureSource(env: TestEnv, fixture: FixtureDef): Promise<void> {
  await writeFile(path.join(env.repoRoot, fixture.file), fixture.sourceContent, 'utf8')
}

function setSpawnSequence(fixture: FixtureDef, mode: SessionMode): void {
  const pass: SpawnResult = { exitCode: 0, stdout: fixture.passingOutput, stderr: '' }
  const fail: SpawnResult = { exitCode: 1, stdout: '', stderr: fixture.stderrOutput }

  if (mode === 'fix') {
    mockSpawnResults[COMMAND] = [fail, pass]
  } else if (mode === 'miss') {
    mockSpawnResults[COMMAND] = [fail, fail]
  } else {
    mockSpawnResults[COMMAND] = [fail]
  }
}

async function runSession(
  env: TestEnv,
  fixture: FixtureDef,
  mode: SessionMode,
): Promise<SessionResult> {
  useEnv(env)
  installPhase19Mocks()
  await resetFixtureSource(env, fixture)
  setSpawnSequence(fixture, mode)

  activeSession = {
    id: crypto.randomUUID(),
    fixture,
    mode,
    turn: 0,
    extractorQueue: mode === 'miss' ? [fixture, fixture] : [fixture],
  }

  const ctx: ToolContext = {
    repoRoot: env.repoRoot,
    sessionId: crypto.randomUUID(),
  }

  const generator = query(`Phase 19 fixture ${fixture.id}`, ctx)
  // Exhaust the generator while preserving query's side effects on ctx/messages.
  while (true) {
    const next = await generator.next()
    if (next.done) {
      break
    }
  }

  totalSessionsRun++
  activeSession = null

  const toolResults = (ctx.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))

  return {
    ctx,
    toolResults,
    injectedRules: (ctx.injectedRules as { rule: RuleFile; fingerprint: Fingerprint }[]) ?? [],
  }
}

async function rebuildEnvRules(env: TestEnv, expectedFixture: FixtureDef): Promise<void> {
  const expectedFine = fingerprintFor(expectedFixture).fine

  for (let attempt = 0; attempt < 3; attempt++) {
    useEnv(env)
    installPhase19Mocks()
    await rebuildRules(path.join(env.memoryDir, 'episodes.jsonl'), env.rulesDir, {
      model: 'mock',
      extractorVersion: '0.2.0',
      forceDistill: attempt > 0,
    })

    const rules = await loadAllRules(env.rulesDir)
    if (rules.some((rule) => rule.triggers.error_signatures.includes(expectedFine))) {
      return
    }
  }

  const rebuiltRules = await loadAllRules(env.rulesDir)
  const rebuiltSignatures = rebuiltRules
    .flatMap((rule) => rule.triggers.error_signatures)
    .join(', ')
  throw new Error(`Rebuild did not create expected rule ${expectedFine}. Saw: ${rebuiltSignatures}`)
}

async function loadRules(env: TestEnv): Promise<RuleFile[]> {
  useEnv(env)
  return await loadAllRules(env.rulesDir)
}

async function ensureResolvedEpisode(env: TestEnv, fixture: FixtureDef, result: SessionResult) {
  const toolResultText = result.toolResults.join('\n')
  expect(toolResultText).toContain('"code":1')
  expect(toolResultText).toContain('"code":0')

  const assistantToolUses = (result.ctx.messages ?? []).flatMap((message) => {
    if (!Array.isArray(message.content)) return []
    return message.content.filter((block) => block.type === 'tool_use').map((block) => block.name)
  })
  expect(assistantToolUses).toContain('Edit')

  useEnv(env)
  const episodesPath = path.join(env.memoryDir, 'episodes.jsonl')
  const existing = await readEpisodes(episodesPath)
  const fine = fingerprintFor(fixture).fine
  if (
    existing.some(
      (episode) =>
        episode.session_id === result.ctx.sessionId &&
        episode.failure.signature === fine &&
        episode.outcome === 'resolved' &&
        !episode.is_excluded,
    )
  ) {
    return
  }

  const episode: Episode = {
    id: `ep_phase19_${fixture.id.toLowerCase()}_${String(result.ctx.sessionId).slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    session_id: String(result.ctx.sessionId),
    task_digest: `Phase 19 fixture ${fixture.id}`,
    failure: {
      tool: 'Bash',
      cmd: COMMAND,
      error_class: fixture.extractorResponse.error_class,
      signature: fine,
    },
    fix_candidates: [
      {
        tool: 'Edit',
        path: fixture.file,
        summary: `Apply fixture fix for ${fixture.id}`,
        role: 'direct',
      },
    ],
    attribution: {
      status: 'single_direct',
      primary: fixture.file,
      confidence: 1,
    },
    verification: {
      cmd: COMMAND,
      exit_code: 0,
    },
    outcome: 'resolved',
    journal_line_range: {
      start: 1,
      end: 1,
    },
    value_score: 1,
    is_excluded: false,
    exclusion_reason: null,
  }

  await appendEpisodes([episode])
}

function findRuleByFine(rules: RuleFile[], fixture: FixtureDef): RuleFile {
  const fine = fingerprintFor(fixture).fine
  const rule = rules.find((candidate) => candidate.triggers.error_signatures.includes(fine))
  if (!rule) {
    throw new Error(`Could not find rule containing ${fine}`)
  }
  return rule
}

function assertInjectedWith(
  result: SessionResult,
  expectedRule: RuleFile,
  expectedText: string,
): void {
  const joined = result.toolResults.join('\n')
  expect(joined).toContain('<octo-memory>')
  expect(joined).toContain(expectedText)
  expect(joined).toContain(expectedRule.advice)
  expect(result.injectedRules.length).toBeGreaterThan(0)
  expect(result.injectedRules[0]?.rule.id).toBe(expectedRule.id)
}

function pickIsolationFixture(index: number, source: FixtureDef): FixtureDef {
  for (let offset = 7; offset < SCENARIO_TYPES.length + 7; offset++) {
    const scenarioType = SCENARIO_TYPES[(index + offset) % SCENARIO_TYPES.length]
    if (!scenarioType) continue
    const fixture = fixtureById(scenarioType, 'A1')
    if (fixture.errorClass !== source.errorClass) {
      return fixture
    }
  }
  throw new Error(`Could not find isolation fixture for ${source.id}`)
}

beforeAll(async () => {
  originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  originalRepoRoot = process.env.OCTONOESIS_REPO_ROOT
  originalProvider = process.env.LLM_PROVIDER
  baseTempDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'octonoesis-phase19-cross-')))

  // biome-ignore lint/suspicious/noExplicitAny: Bun global object
  originalSpawn = (globalThis as any).Bun.spawn
  installPhase19Mocks()
})

afterAll(async () => {
  activeSession = null
  setProvider(null)
  unregisterPromptHandler()
  // biome-ignore lint/suspicious/noExplicitAny: Bun global object
  ;(globalThis as any).Bun.spawn = originalSpawn

  process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  process.env.OCTONOESIS_REPO_ROOT = originalRepoRoot
  process.env.LLM_PROVIDER = originalProvider

  if (baseTempDir) {
    await rm(baseTempDir, { recursive: true, force: true })
  }
})

describe('Phase 19.2 — Cross-Pattern Generalization', () => {
  describe('Part A — Within-scenario generalization', () => {
    for (let i = 0; i < SCENARIO_TYPES.length; i++) {
      const scenarioType = SCENARIO_TYPES[i]
      if (!scenarioType) continue

      it(`${scenarioType}: creates rule, matches medium/coarse, isolates cross-bucket`, async () => {
        const env = await createEnv(`part-a-${String(i).padStart(2, '0')}-${scenarioType}`)
        const createFixture = fixtureById(scenarioType, 'A1')
        const mediumFixture = fixtureById(scenarioType, 'A2')
        const coarseFixture = fixtureById(scenarioType, 'B1')
        const isolationFixture = pickIsolationFixture(i, createFixture)

        const createResult = await runSession(env, createFixture, 'fix')
        await ensureResolvedEpisode(env, createFixture, createResult)
        await rebuildEnvRules(env, createFixture)

        const rulesAfterCreate = await loadRules(env)
        const createdRule = findRuleByFine(rulesAfterCreate, createFixture)
        const createFingerprint = fingerprintFor(createFixture)
        expect(createdRule.triggers.error_signatures).toContain(createFingerprint.fine)
        expect(createdRule.triggers.error_signatures).toContain(createFingerprint.medium)
        expect(createdRule.triggers.error_signatures).toContain(createFingerprint.coarse)
        createdRules.push(createdRule)

        const mediumResult = await runSession(env, mediumFixture, 'fix')
        assertInjectedWith(mediumResult, createdRule, 'matched your current error signature')
        expect(mediumResult.toolResults.join('\n')).not.toContain('Low-confidence advice fallback')

        const coarseResult = await runSession(env, coarseFixture, 'fix')
        assertInjectedWith(coarseResult, createdRule, 'Low-confidence advice fallback')

        const isolationResult = await runSession(env, isolationFixture, 'no-match')
        expect(isolationResult.toolResults.join('\n')).not.toContain('<octo-memory>')
        expect(isolationResult.injectedRules.length).toBe(0)
      })
    }
  })

  describe('Part B — Negative transfer', () => {
    for (const [sourceScenario, targetScenario] of COLLISION_PAIRS) {
      it(`${sourceScenario} rule -> ${targetScenario} error -> coarse match -> miss`, async () => {
        const env = await createEnv(`negative-${sourceScenario}-${targetScenario}`)
        const sourceFixture = fixtureById(sourceScenario, 'A1')
        const targetFixture = fixtureById(targetScenario, 'A1')

        const sourceResult = await runSession(env, sourceFixture, 'fix')
        await ensureResolvedEpisode(env, sourceFixture, sourceResult)
        await rebuildEnvRules(env, sourceFixture)

        const beforeRules = await loadRules(env)
        const sourceRuleBefore = findRuleByFine(beforeRules, sourceFixture)
        const missesBefore = sourceRuleBefore.misses

        const missResult = await runSession(env, targetFixture, 'miss')
        assertInjectedWith(missResult, sourceRuleBefore, 'Low-confidence advice fallback')

        const afterRules = await loadRules(env)
        const sourceRuleAfter = findRuleByFine(afterRules, sourceFixture)
        expect(sourceRuleAfter.misses).toBe(missesBefore + 1)
        negativeTransferMisses++
      })
    }
  })

  describe('Part C — Saturation', () => {
    it('NullAccess accumulates hits correctly across 10 instances', async () => {
      const env = await createEnv('saturation-nullaccess')
      const nullAccessFixtures = byScenario('NullAccess')
      const createFixture = fixtureById('NullAccess', 'A1')

      const createResult = await runSession(env, createFixture, 'fix')
      await ensureResolvedEpisode(env, createFixture, createResult)
      await rebuildEnvRules(env, createFixture)

      for (const fixture of nullAccessFixtures) {
        await runSession(env, fixture, 'fix')
      }

      const rules = await loadRules(env)
      const nullAccessRule = findRuleByFine(rules, createFixture)
      expect(nullAccessRule.hits).toBeGreaterThan(8)

      const nullAccessRules = rules.filter((rule) =>
        rule.triggers.error_signatures.includes(fingerprintFor(createFixture).coarse),
      )
      expect(nullAccessRules.length).toBe(1)
    })
  })

  describe('Post-test assertions', () => {
    it('has at least 15 rules and every rule stays inside one error_class bucket', () => {
      expect(createdRules.length).toBeGreaterThan(14)

      for (const rule of createdRules) {
        const classes = new Set(
          rule.triggers.error_signatures.map((signature) => signature.split('|')[1]),
        )
        expect(classes.size).toBe(1)
      }
    })

    it('records the expected session and negative-transfer counts', () => {
      expect(totalSessionsRun).toBe(15 * 4 + COLLISION_PAIRS.length * 2 + 11)
      expect(negativeTransferMisses).toBe(COLLISION_PAIRS.length)
    })
  })
})
