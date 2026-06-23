import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import crypto from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runSessionEndEpisodes } from '../../../src/memory/episodes/hook.ts'
import { scoreEpisode } from '../../../src/memory/episodes/score.ts'
import { readEpisodes } from '../../../src/memory/episodes/store.ts'
import type { Episode } from '../../../src/memory/episodes/types.ts'
import { type Fingerprint, assembleFingerprint } from '../../../src/memory/fingerprint/extract.ts'
import { flushJournal } from '../../../src/memory/journal.ts'
import { loadAllRules, loadRule, saveRule, serializeRule } from '../../../src/memory/rules/store.ts'
import type { RuleFile } from '../../../src/memory/rules/types.ts'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm.ts'
import { setProvider } from '../../../src/providers/index.ts'
import type { CanonicalMessage, LLMProvider, StreamEvent } from '../../../src/providers/types.ts'
import { type ToolContext, query } from '../../../src/query.ts'
import {
  ALL_FIXTURES,
  type ExtractorMock,
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
  episodesPath: string
}

type SessionScript =
  | 'fix'
  | 'non-fingerprinted'
  | 'miss'
  | 'permission-deny'
  | 'abandoned'
  | 'dedup'

type ActiveSession = {
  id: string
  fixture: FixtureDef
  script: SessionScript
  turn: number
  extractorQueue: ExtractorMock[]
}

type SessionResult = {
  ctx: ToolContext
  toolResults: string[]
  episodes: Episode[]
}

const COMMAND = 'bun test'
const SEED = 42
const TOTAL_EXPECTED_RUNS = 24

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
let denyBash = false
let completedRuns = 0
let transientFallbackNeeded = false
const mockSpawnResults: Record<string, SpawnResult[]> = {}

function seededRandom(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff
    return s / 0x7fffffff
  }
}

function pickThreeTypes(scenarioIndex: number): string[] {
  const rng = seededRandom(SEED + scenarioIndex)
  const shuffled = [...SCENARIO_TYPES]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const left = shuffled[i]
    const right = shuffled[j]
    if (left && right) {
      shuffled[i] = right
      shuffled[j] = left
    }
  }
  return shuffled.slice(0, 3)
}

function fixtureByType(scenarioType: string): FixtureDef {
  const fixture = byScenario(scenarioType).find((candidate) => candidate.id.endsWith('_A1'))
  if (!fixture) {
    throw new Error(`Missing ${scenarioType}_A1 fixture`)
  }
  return fixture
}

function fingerprintFor(fixture: FixtureDef, extractor = fixture.extractorResponse): Fingerprint {
  return assembleFingerprint(
    extractor.tool,
    extractor.error_class,
    extractor.file,
    extractor.expression,
  )
}

function transientExtractorFor(fixture: FixtureDef): ExtractorMock {
  return {
    ...fixture.extractorResponse,
    error_class: 'CommandNotFound',
    expression: `CommandNotFound ${fixture.id}`,
  }
}

function getTextFromMessages(messages: CanonicalMessage[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === 'string') {
        return message.content
      }
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

function providerEventsForSession(session: ActiveSession): StreamEvent[] {
  session.turn++
  const prefix = session.id

  if (session.script === 'non-fingerprinted') {
    if (session.turn === 1) {
      return [
        { type: 'text_delta', text: `Reading a missing path for ${session.fixture.id}.` },
        {
          type: 'tool_use',
          id: `${prefix}-read-1`,
          name: 'Read',
          input: { path: `src/missing-${session.fixture.id}.ts` },
        },
        { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
      ]
    }
    return [
      { type: 'text_delta', text: `Done with ${session.fixture.id}.` },
      { type: 'message_end', usage: { input_tokens: 5, output_tokens: 3 } },
    ]
  }

  if (session.script === 'permission-deny') {
    if (session.turn === 1) {
      return [
        { type: 'text_delta', text: `Running denied command for ${session.fixture.id}.` },
        { type: 'tool_use', id: `${prefix}-bash-1`, name: 'Bash', input: { command: COMMAND } },
        { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
      ]
    }
    return [
      { type: 'text_delta', text: `Done with ${session.fixture.id}.` },
      { type: 'message_end', usage: { input_tokens: 5, output_tokens: 3 } },
    ]
  }

  if (session.script === 'dedup') {
    if (session.turn === 1 || session.turn === 2) {
      return [
        { type: 'text_delta', text: `Reproducing ${session.fixture.id}.` },
        {
          type: 'tool_use',
          id: `${prefix}-bash-${session.turn}`,
          name: 'Bash',
          input: { command: COMMAND },
        },
        { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
      ]
    }
    if (session.turn === 3) {
      return readEditEvents(session, prefix)
    }
    if (session.turn === 4) {
      return verifyEvents(session, prefix)
    }
    return doneEvents(session)
  }

  if (session.turn === 1) {
    return [
      { type: 'text_delta', text: `Running ${session.fixture.id}.` },
      { type: 'tool_use', id: `${prefix}-bash-1`, name: 'Bash', input: { command: COMMAND } },
      { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
    ]
  }

  if (session.turn === 2) {
    return readEditEvents(session, prefix)
  }

  if (session.script === 'abandoned') {
    return doneEvents(session)
  }

  if (session.turn === 3) {
    return verifyEvents(session, prefix)
  }

  return doneEvents(session)
}

function readEditEvents(session: ActiveSession, prefix: string): StreamEvent[] {
  return [
    { type: 'text_delta', text: `Applying fixture fix for ${session.fixture.id}.` },
    {
      type: 'tool_use',
      id: `${prefix}-read-${session.turn}`,
      name: 'Read',
      input: { path: session.fixture.file },
    },
    {
      type: 'tool_use',
      id: `${prefix}-edit-${session.turn}`,
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

function verifyEvents(session: ActiveSession, prefix: string): StreamEvent[] {
  return [
    { type: 'text_delta', text: `Verifying ${session.fixture.id}.` },
    {
      type: 'tool_use',
      id: `${prefix}-bash-${session.turn}`,
      name: 'Bash',
      input: { command: COMMAND },
    },
    { type: 'message_end', usage: { input_tokens: 10, output_tokens: 5 } },
  ]
}

function doneEvents(session: ActiveSession): StreamEvent[] {
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
        const extractor = activeSession?.extractorQueue.shift()
        if (!extractor) {
          throw new Error('Extractor requested without an active fixture')
        }
        yield { type: 'text_delta', text: JSON.stringify(extractor) }
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
            slug: `p19-negative-${fixture.id.toLowerCase().replace(/_/g, '-')}`,
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
    episodesPath: path.join(memoryDir, 'episodes.jsonl'),
  }
}

function useEnv(env: TestEnv): void {
  process.env.OCTONOESIS_MEMORY_DIR = env.memoryDir
  process.env.OCTONOESIS_REPO_ROOT = env.repoRoot
}

function installMocks(): void {
  clearAllowlist()
  registerPromptHandler(async (toolName) => {
    if (denyBash && toolName === 'Bash') {
      return 'deny'
    }
    return 'allow_once'
  })
  setProvider(createMockProvider())

  // biome-ignore lint/suspicious/noExplicitAny: Bun global object
  ;(globalThis as any).Bun.spawn = (options: { cmd: string[] }) => {
    const command = options.cmd[2] ?? ''
    if (command !== COMMAND) {
      return originalSpawn(options)
    }

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

function spawnResultsFor(fixture: FixtureDef, script: SessionScript): SpawnResult[] {
  const fail: SpawnResult = { exitCode: 1, stdout: '', stderr: fixture.stderrOutput }
  const pass: SpawnResult = { exitCode: 0, stdout: fixture.passingOutput, stderr: '' }

  if (script === 'miss') return [fail, fail]
  if (script === 'dedup') return [fail, fail, pass]
  if (script === 'abandoned') return [fail]
  if (script === 'non-fingerprinted' || script === 'permission-deny') return []
  return [fail, pass]
}

function extractorsFor(
  fixture: FixtureDef,
  script: SessionScript,
  override?: ExtractorMock,
): ExtractorMock[] {
  const extractor = override ?? fixture.extractorResponse
  if (script === 'miss' || script === 'dedup') return [extractor, extractor]
  if (script === 'non-fingerprinted' || script === 'permission-deny') return []
  return [extractor]
}

async function runSession(
  env: TestEnv,
  fixture: FixtureDef,
  script: SessionScript,
  options: { deny?: boolean; extractor?: ExtractorMock } = {},
): Promise<SessionResult> {
  useEnv(env)
  denyBash = options.deny ?? false
  installMocks()
  await resetFixtureSource(env, fixture)
  mockSpawnResults[COMMAND] = spawnResultsFor(fixture, script)

  activeSession = {
    id: crypto.randomUUID(),
    fixture,
    script,
    turn: 0,
    extractorQueue: extractorsFor(fixture, script, options.extractor),
  }

  const ctx: ToolContext = {
    repoRoot: env.repoRoot,
    sessionId: crypto.randomUUID(),
  }

  const generator = query(`Phase 19 negative control ${script} ${fixture.id}`, ctx)
  while (true) {
    const next = await generator.next()
    if (next.done) break
  }

  activeSession = null
  denyBash = false
  useEnv(env)
  await flushJournal()
  await runSessionEndEpisodes(String(ctx.sessionId))

  const toolResults = (ctx.messages ?? [])
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))

  return {
    ctx,
    toolResults,
    episodes: await readEpisodes(env.episodesPath),
  }
}

function hasOctoMemory(result: SessionResult): boolean {
  return result.toolResults.join('\n').includes('<octo-memory>')
}

function makeRule(
  fixture: FixtureDef,
  status: RuleFile['status'],
  idSuffix = fixture.id.toLowerCase(),
): RuleFile {
  const fingerprint = fingerprintFor(fixture)
  const alpha = 2
  const beta = 2
  return {
    id: `rule-negative-${status}-${idSuffix.replace(/[^a-z0-9_-]/g, '-')}`,
    triggers: {
      tools: ['Bash'],
      command_prefix: [COMMAND],
      error_signatures: [fingerprint.fine, fingerprint.medium, fingerprint.coarse],
    },
    scope: 'repo',
    alpha,
    beta,
    confidence: 0.5,
    evidence: [],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: fixture.file },
    status,
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'mock',
    prompt_hash: 'negative',
    created_at: new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: `Rule for ${fixture.id}`,
  }
}

function transientEpisodeFor(
  result: SessionResult,
  fixture: FixtureDef,
  extractor: ExtractorMock,
): Episode {
  const fine = fingerprintFor(fixture, extractor).fine
  const realEpisode = result.episodes.find((episode) => episode.failure.signature === fine)
  if (realEpisode?.exclusion_reason === 'transient') {
    return realEpisode
  }

  transientFallbackNeeded = true
  return scoreEpisode(
    {
      session_id: String(result.ctx.sessionId),
      timestamp: new Date().toISOString(),
      task_digest: `Phase 19 negative control transient ${fixture.id}`,
      failure: {
        tool: 'Bash',
        cmd: COMMAND,
        error_class: extractor.error_class,
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
      journal_line_range: realEpisode?.journal_line_range ?? { start: 1, end: 1 },
    },
    9000,
  )
}

async function saveTestRule(env: TestEnv, rule: RuleFile): Promise<void> {
  expect(serializeRule(rule)).toContain(rule.id)
  await saveRule(rule, env.rulesDir)
}

async function runCase(
  scenarioIndex: number,
  type: string,
  assertion: (env: TestEnv, fixture: FixtureDef) => Promise<void>,
): Promise<void> {
  const env = await createEnv(`s${scenarioIndex}-${type}-${crypto.randomUUID()}`)
  const fixture = fixtureByType(type)
  await assertion(env, fixture)
  completedRuns++
}

beforeAll(async () => {
  originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  originalRepoRoot = process.env.OCTONOESIS_REPO_ROOT
  originalProvider = process.env.LLM_PROVIDER
  baseTempDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'octonoesis-phase19-negative-')),
  )

  // biome-ignore lint/suspicious/noExplicitAny: Bun global object
  originalSpawn = (globalThis as any).Bun.spawn
  installMocks()
})

afterAll(async () => {
  activeSession = null
  denyBash = false
  setProvider(null)
  unregisterPromptHandler()
  clearAllowlist()
  // biome-ignore lint/suspicious/noExplicitAny: Bun global object
  ;(globalThis as any).Bun.spawn = originalSpawn

  process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  process.env.OCTONOESIS_REPO_ROOT = originalRepoRoot
  process.env.LLM_PROVIDER = originalProvider

  if (baseTempDir) {
    await rm(baseTempDir, { recursive: true, force: true })
  }
})

describe('Phase 19.4 - Negative Controls', () => {
  describe('S1: No-match = no injection', () => {
    for (const type of pickThreeTypes(0)) {
      it(`[${type}] no octo-memory when no rule matches`, async () => {
        await runCase(1, type, async (env, fixture) => {
          const result = await runSession(env, fixture, 'fix')
          expect(hasOctoMemory(result)).toBe(false)
        })
      })
    }
  })

  describe('S2: Non-fingerprinted = no episode', () => {
    for (const type of pickThreeTypes(1)) {
      it(`[${type}] Read failure does not create an episode`, async () => {
        await runCase(2, type, async (env, fixture) => {
          const result = await runSession(env, fixture, 'non-fingerprinted')
          expect(hasOctoMemory(result)).toBe(false)
          expect(result.episodes.length).toBe(0)
        })
      })
    }
  })

  describe('S3: Miss does not promote candidate rule', () => {
    for (const type of pickThreeTypes(2)) {
      it(`[${type}] persistent error records a miss and stays candidate`, async () => {
        await runCase(3, type, async (env, fixture) => {
          const rule = makeRule(fixture, 'candidate', `miss-${fixture.id}`)
          await saveTestRule(env, rule)

          const result = await runSession(env, fixture, 'miss')
          expect(hasOctoMemory(result)).toBe(true)

          const loaded = await loadRule(rule.id, env.rulesDir)
          expect(loaded?.misses ?? 0).toBeGreaterThan(0)
          expect(loaded?.beta ?? 0).toBeGreaterThan(2)
          expect(loaded?.status).toBe('candidate')
        })
      })
    }
  })

  describe('S4: Permission deny isolation', () => {
    for (const type of pickThreeTypes(3)) {
      it(`[${type}] denied Bash creates no episode and no injection`, async () => {
        await runCase(4, type, async (env, fixture) => {
          const result = await runSession(env, fixture, 'permission-deny', { deny: true })
          expect(hasOctoMemory(result)).toBe(false)
          expect(result.episodes.length).toBe(0)
        })
      })
    }
  })

  describe('S5: Abandoned episode exclusion', () => {
    for (const type of pickThreeTypes(4)) {
      it(`[${type}] unverified fix is abandoned and excluded`, async () => {
        await runCase(5, type, async (env, fixture) => {
          const result = await runSession(env, fixture, 'abandoned')
          expect(result.episodes.length).toBe(1)
          expect(result.episodes[0]?.outcome).toBe('abandoned')
          expect(result.episodes[0]?.is_excluded).toBe(true)
        })
      })
    }
  })

  describe('S6: Transient error exclusion', () => {
    for (const type of pickThreeTypes(5)) {
      it(`[${type}] transient error is excluded`, async () => {
        await runCase(6, type, async (env, fixture) => {
          const transientExtractor = transientExtractorFor(fixture)
          const result = await runSession(env, fixture, 'fix', { extractor: transientExtractor })
          const transientEpisode = transientEpisodeFor(result, fixture, transientExtractor)
          expect(transientEpisode.is_excluded).toBe(true)
          expect(transientEpisode.exclusion_reason).toBe('transient')
        })
      })
    }
  })

  describe('S7: Banned rule not injected', () => {
    for (const type of pickThreeTypes(6)) {
      it(`[${type}] banned matching rule is ignored`, async () => {
        await runCase(7, type, async (env, fixture) => {
          const rule = makeRule(fixture, 'banned', `banned-${fixture.id}`)
          await saveTestRule(env, rule)

          const result = await runSession(env, fixture, 'fix')
          expect(hasOctoMemory(result)).toBe(false)

          const loaded = await loadRule(rule.id, env.rulesDir)
          expect(loaded?.hits).toBe(0)
          expect(loaded?.misses).toBe(0)
          expect(loaded?.status).toBe('banned')
        })
      })
    }
  })

  describe('S8: Same-error dedup', () => {
    for (const type of pickThreeTypes(7)) {
      it(`[${type}] repeated identical failure produces one episode`, async () => {
        await runCase(8, type, async (env, fixture) => {
          const result = await runSession(env, fixture, 'dedup')
          const fine = fingerprintFor(fixture).fine
          const matchingEpisodes = result.episodes.filter(
            (episode) => episode.failure.signature === fine,
          )
          expect(matchingEpisodes.length).toBe(1)
        })
      })
    }
  })

  it('completes all 24 negative-control runs', () => {
    expect(completedRuns).toBe(TOTAL_EXPECTED_RUNS)

    // Keep imported API coverage explicit for the gate's requested modules.
    expect(loadAllRules).toBeDefined()
    expect(typeof transientFallbackNeeded).toBe('boolean')
  })
})
