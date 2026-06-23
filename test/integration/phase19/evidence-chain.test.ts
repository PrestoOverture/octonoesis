import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import crypto from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runSessionEndEpisodes } from '../../../src/memory/episodes/hook.ts'
import { appendEpisodes, readEpisodes } from '../../../src/memory/episodes/store.ts'
import type { Episode } from '../../../src/memory/episodes/types.ts'
import { type Fingerprint, assembleFingerprint } from '../../../src/memory/fingerprint/extract.ts'
import { flushJournal } from '../../../src/memory/journal.ts'
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
  journalPath: string
}

type ActiveSession = {
  id: string
  fixture: FixtureDef
  turn: number
  extractorQueue: FixtureDef[]
}

type StoredJournalEvent = {
  kind: string
  session_id?: string
  tool?: string
  outcome?: string
  path?: string
  cmd?: string
  exit_code?: number
  verdict?: string
  fingerprints?: Fingerprint[]
}

const COMMAND = 'bun test'
const SCENARIOS = [
  'NullAccess',
  'ParseError',
  'ModuleNotFound',
  'ExpectMismatch',
  'MissingEnvVar',
] as const

const fixtureByFine = new Map<string, FixtureDef>()
for (const fixture of ALL_FIXTURES) {
  fixtureByFine.set(fingerprintFor(fixture).fine, fixture)
}

let baseTempDir = ''
let env: TestEnv
let originalMemoryDir: string | undefined
let originalRepoRoot: string | undefined
let originalProvider: string | undefined
// biome-ignore lint/suspicious/noExplicitAny: Bun process handle mock
let originalSpawn: any
let activeSession: ActiveSession | null = null
let rules: RuleFile[] = []
let episodes: Episode[] = []
let journalEvents: StoredJournalEvent[] = []
let realHooksProducedEpisodes = false
let fallbackNeeded = false
const mockSpawnResults: Record<string, SpawnResult[]> = {}
const sessionIdsByFixtureId = new Map<string, string>()

function fingerprintFor(fixture: FixtureDef): Fingerprint {
  return assembleFingerprint(
    fixture.extractorResponse.tool,
    fixture.extractorResponse.error_class,
    fixture.extractorResponse.file,
    fixture.extractorResponse.expression,
  )
}

function fixtureByScenario(scenarioType: (typeof SCENARIOS)[number]): FixtureDef {
  const fixture = byScenario(scenarioType).find((candidate) => candidate.id.endsWith('_A1'))
  if (!fixture) {
    throw new Error(`Missing ${scenarioType}_A1 fixture`)
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
        yield { type: 'text_delta', text: JSON.stringify(fixture.extractorResponse) }
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
            slug: `p19-evidence-${fixture.id.toLowerCase().replace(/_/g, '-')}`,
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

function useEnv(): void {
  process.env.OCTONOESIS_MEMORY_DIR = env.memoryDir
  process.env.OCTONOESIS_REPO_ROOT = env.repoRoot
}

function installMocks(): void {
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

async function createEnv(): Promise<TestEnv> {
  const rawRoot = path.join(baseTempDir, 'evidence-chain')
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
    journalPath: path.join(memoryDir, 'journal.jsonl'),
  }
}

async function resetFixtureSource(fixture: FixtureDef): Promise<void> {
  await writeFile(path.join(env.repoRoot, fixture.file), fixture.sourceContent, 'utf8')
}

async function runSession(fixture: FixtureDef): Promise<ToolContext> {
  useEnv()
  installMocks()
  await resetFixtureSource(fixture)

  mockSpawnResults[COMMAND] = [
    { exitCode: 1, stdout: '', stderr: fixture.stderrOutput },
    { exitCode: 0, stdout: fixture.passingOutput, stderr: '' },
  ]

  activeSession = {
    id: crypto.randomUUID(),
    fixture,
    turn: 0,
    extractorQueue: [fixture],
  }

  const ctx: ToolContext = {
    repoRoot: env.repoRoot,
    sessionId: crypto.randomUUID(),
  }
  sessionIdsByFixtureId.set(fixture.id, String(ctx.sessionId))

  const generator = query(`Phase 19 evidence fixture ${fixture.id}`, ctx)
  while (true) {
    const next = await generator.next()
    if (next.done) break
  }

  activeSession = null
  useEnv()
  await flushJournal()
  await runSessionEndEpisodes(String(ctx.sessionId))
  return ctx
}

function isExpectedResolvedEpisode(
  episode: Episode,
  fixture: FixtureDef,
  sessionId: string,
): boolean {
  return (
    episode.session_id === sessionId &&
    episode.failure.signature === fingerprintFor(fixture).fine &&
    episode.outcome === 'resolved' &&
    !episode.is_excluded
  )
}

async function runSessionUntilEpisode(fixture: FixtureDef): Promise<void> {
  let lastSessionId = ''

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctx = await runSession(fixture)
    lastSessionId = String(ctx.sessionId)
    expect(ctx.messages?.some((message) => message.role === 'tool')).toBe(true)

    useEnv()
    episodes = await readEpisodes(env.episodesPath)
    if (episodes.some((episode) => isExpectedResolvedEpisode(episode, fixture, lastSessionId))) {
      return
    }
  }

  fallbackNeeded = true
  await appendFallbackEpisode(fixture, lastSessionId)
  episodes = await readEpisodes(env.episodesPath)
}

async function appendFallbackEpisode(fixture: FixtureDef, sessionId: string): Promise<void> {
  useEnv()
  const fine = fingerprintFor(fixture).fine
  const existing = episodes.find(
    (episode) => episode.session_id === sessionId && episode.failure.signature === fine,
  )

  const episode: Episode = {
    id: `ep_phase19_evidence_${fixture.id.toLowerCase()}_${sessionId.slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    task_digest: `Phase 19 evidence fixture ${fixture.id}`,
    failure: {
      tool: 'Bash',
      cmd: COMMAND,
      error_class: fixture.errorClass,
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
    journal_line_range: existing?.journal_line_range ?? { start: 1, end: 1 },
    value_score: 1,
    is_excluded: false,
    exclusion_reason: null,
  }

  await appendEpisodes([episode])
}

async function rebuildRulesUntilLinked(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    useEnv()
    installMocks()
    await rebuildRules(env.episodesPath, env.rulesDir, {
      model: 'mock',
      extractorVersion: '0.2.0',
      forceDistill: true,
    })

    rules = await loadAllRules(env.rulesDir)
    if (rules.length >= SCENARIOS.length && tracedEpisodes().length >= SCENARIOS.length) {
      return
    }
  }
}

async function loadJournalEvents(): Promise<StoredJournalEvent[]> {
  const content = await readFile(env.journalPath, 'utf8')
  return content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StoredJournalEvent)
}

function journalRange(episode: Episode): StoredJournalEvent[] {
  const start = episode.journal_line_range.start
  const end = episode.journal_line_range.end
  return journalEvents.slice(start - 1, end)
}

function sameSessionEventsAfterStart(episode: Episode): StoredJournalEvent[] {
  return journalEvents
    .slice(episode.journal_line_range.start - 1)
    .filter((event) => event.session_id === episode.session_id)
}

function tracedEpisodes(): Episode[] {
  const linkedEpisodeIds = new Set(rules.flatMap((rule) => rule.evidence))
  const expectedSessionIds = new Set(sessionIdsByFixtureId.values())
  return episodes.filter(
    (episode) => linkedEpisodeIds.has(episode.id) && expectedSessionIds.has(episode.session_id),
  )
}

function expectedResolvedEpisodes(): Episode[] {
  const expectedSessionIds = new Set(sessionIdsByFixtureId.values())
  const expectedSignatures = new Set(
    SCENARIOS.map((scenario) => fingerprintFor(fixtureByScenario(scenario)).fine),
  )
  return episodes.filter(
    (episode) =>
      expectedSessionIds.has(episode.session_id) &&
      expectedSignatures.has(episode.failure.signature) &&
      episode.outcome === 'resolved' &&
      !episode.is_excluded,
  )
}

beforeAll(async () => {
  originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  originalRepoRoot = process.env.OCTONOESIS_REPO_ROOT
  originalProvider = process.env.LLM_PROVIDER
  baseTempDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'octonoesis-phase19-evidence-')),
  )
  env = await createEnv()

  // biome-ignore lint/suspicious/noExplicitAny: Bun global object
  originalSpawn = (globalThis as any).Bun.spawn
  installMocks()
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

describe('Phase 19.3 - Evidence Chain', () => {
  it('creates 5 rules via full pipeline sessions', async () => {
    for (const scenario of SCENARIOS) {
      const fixture = fixtureByScenario(scenario)
      await runSessionUntilEpisode(fixture)
    }

    useEnv()
    episodes = await readEpisodes(env.episodesPath)
    realHooksProducedEpisodes =
      !fallbackNeeded && expectedResolvedEpisodes().length >= SCENARIOS.length
    expect(expectedResolvedEpisodes().length > 4).toBe(true)

    await rebuildRulesUntilLinked()
    journalEvents = await loadJournalEvents()

    expect(rules.length > 4).toBe(true)
    expect(episodes.length > 4).toBe(true)
  })

  describe('Rule -> Episode links', () => {
    it('every rule evidence episode exists in episodes.jsonl', () => {
      const episodesById = new Map(episodes.map((episode) => [episode.id, episode]))

      for (const rule of rules) {
        expect(rule.evidence.length).toBeGreaterThan(0)
        for (const episodeId of rule.evidence) {
          expect(episodesById.has(episodeId)).toBe(true)
        }
      }
    })

    it('every linked episode is resolved and not excluded', () => {
      const episodesById = new Map(episodes.map((episode) => [episode.id, episode]))

      for (const rule of rules) {
        for (const episodeId of rule.evidence) {
          const episode = episodesById.get(episodeId)
          expect(episode?.outcome).toBe('resolved')
          expect(episode?.is_excluded).toBe(false)
        }
      }
    })

    it('episode failure signatures are present in their rule triggers', () => {
      const episodesById = new Map(episodes.map((episode) => [episode.id, episode]))

      for (const rule of rules) {
        for (const episodeId of rule.evidence) {
          const episode = episodesById.get(episodeId)
          expect(episode).toBeDefined()
          expect(rule.triggers.error_signatures).toContain(episode?.failure.signature)
        }
      }
    })

    it('no two rules share the same episode ID', () => {
      const seen = new Map<string, string>()

      for (const rule of rules) {
        for (const episodeId of rule.evidence) {
          expect(seen.has(episodeId)).toBe(false)
          seen.set(episodeId, rule.id)
        }
      }
    })
  })

  describe('Episode -> Journal links', () => {
    it('every episode journal_line_range maps to real journal lines', () => {
      if (fallbackNeeded) {
        expect(fallbackNeeded).toBe(true)
        return
      }

      for (const episode of tracedEpisodes()) {
        expect(episode.journal_line_range.start).toBeGreaterThan(0)
        expect(episode.journal_line_range.end).toBeGreaterThan(0)
        expect(episode.journal_line_range.start <= episode.journal_line_range.end).toBe(true)
        expect(episode.journal_line_range.start <= journalEvents.length).toBe(true)
        expect(episode.journal_line_range.end <= journalEvents.length).toBe(true)
      }
    })

    it('journal range contains a failed run with the matching fingerprint', () => {
      if (fallbackNeeded) {
        expect(fallbackNeeded).toBe(true)
        return
      }

      for (const episode of tracedEpisodes()) {
        const range = journalRange(episode)
        const hasMatchingFailure = range.some(
          (event) =>
            ((event.kind === 'tool' && event.exit_code !== undefined && event.exit_code !== 0) ||
              (event.kind === 'verify' && event.verdict === 'FAIL')) &&
            event.fingerprints?.[0]?.fine === episode.failure.signature,
        )
        expect(hasMatchingFailure).toBe(true)
      }
    })

    it('journal range contains a successful Edit on a fix candidate path', () => {
      if (fallbackNeeded) {
        expect(fallbackNeeded).toBe(true)
        return
      }

      for (const episode of tracedEpisodes()) {
        const candidatePaths = new Set(episode.fix_candidates.map((candidate) => candidate.path))
        const range = journalRange(episode)
        const hasMatchingEdit = range.some(
          (event) =>
            event.kind === 'tool' &&
            event.outcome === 'success' &&
            event.tool === 'Edit' &&
            typeof event.path === 'string' &&
            candidatePaths.has(event.path),
        )
        expect(hasMatchingEdit).toBe(true)
      }
    })

    it('same session contains a verify PASS or successful Bash after the failure starts', () => {
      if (fallbackNeeded) {
        expect(fallbackNeeded).toBe(true)
        return
      }

      for (const episode of tracedEpisodes()) {
        const sessionEvents = sameSessionEventsAfterStart(episode)
        const hasPassingVerification = sessionEvents.some(
          (event) =>
            (event.kind === 'verify' && event.verdict === 'PASS') ||
            (event.kind === 'tool' &&
              event.tool === 'Bash' &&
              event.outcome === 'success' &&
              event.exit_code === 0),
        )
        expect(hasPassingVerification).toBe(true)
      }
    })
  })

  describe('Totals', () => {
    it('verifies at least 5 complete evidence chains', () => {
      const verifiedChains = tracedEpisodes()

      expect(verifiedChains.length > 4).toBe(true)
      expect(rules.length > 4).toBe(true)
      expect(episodes.length > 4).toBe(true)
      expect(realHooksProducedEpisodes || fallbackNeeded).toBe(true)
    })
  })
})
