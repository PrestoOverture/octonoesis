import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import crypto from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createPrior,
  intervalWidth,
  posteriorMean,
  update,
} from '../../../src/memory/calibration/beta.ts'
import { formatStatsTable } from '../../../src/memory/calibration/format.ts'
import { type Recommendation, assessBucket } from '../../../src/memory/calibration/policy.ts'
import {
  type BucketStats,
  type CalibrationRecord,
  aggregateCalibrationStats,
  appendCalibrationRecords,
  readCalibrationRecords,
} from '../../../src/memory/calibration/stats.ts'
import { runSessionEndEpisodes } from '../../../src/memory/episodes/hook.ts'
import { type Fingerprint, assembleFingerprint } from '../../../src/memory/fingerprint/extract.ts'
import { flushJournal } from '../../../src/memory/journal.ts'
import { registerPromptHandler, unregisterPromptHandler } from '../../../src/permissions/confirm.ts'
import { setProvider } from '../../../src/providers/index.ts'
import type { CanonicalMessage, LLMProvider, StreamEvent } from '../../../src/providers/types.ts'
import { type ToolContext, query } from '../../../src/query.ts'
import {
  ALL_FIXTURES,
  type ExtractorMock,
  type FixtureDef,
  byScenario,
  materializeRepo,
} from '../../fixtures/learning-demo/fixtures.ts'
import { restoreEnv } from '../../helpers/env.ts'

type SpawnResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type TestEnv = {
  repoRoot: string
  memoryDir: string
  calibrationPath: string
}

type SessionMode = 'hit' | 'miss'

type ActiveSession = {
  id: string
  fixture: FixtureDef
  mode: SessionMode
  turn: number
  extractorQueue: ExtractorMock[]
}

const COMMAND = 'bun test'
const MODEL_ID = 'mock'
const NULLACCESS_BUCKET = 'bun-test|TypeError'
const MEAN_TOLERANCE = 0.02
const CI_TOLERANCE = 0.05
const EXPECTED_TOTAL_RECORDS = 196

const PHASE_C_BUCKETS: Array<{
  bucket: string
  hits: number
  misses: number
  recommendation: Recommendation
}> = [
  { bucket: 'UndefinedRef', hits: 13, misses: 3, recommendation: 'confident' },
  { bucket: 'ParseError', hits: 16, misses: 2, recommendation: 'confident' },
  { bucket: 'OutOfBounds', hits: 10, misses: 3, recommendation: 'confident' },
  { bucket: 'ModuleNotFound', hits: 12, misses: 2, recommendation: 'confident' },
  { bucket: 'MissingExport', hits: 1, misses: 10, recommendation: 'review-recommended' },
  { bucket: 'ExpectMismatch', hits: 2, misses: 12, recommendation: 'review-recommended' },
  { bucket: 'SnapshotDrift', hits: 1, misses: 7, recommendation: 'review-recommended' },
  { bucket: 'TypeMismatch', hits: 3, misses: 13, recommendation: 'review-recommended' },
  { bucket: 'PromiseReject', hits: 2, misses: 8, recommendation: 'review-recommended' },
  { bucket: 'JSONMalformed', hits: 1, misses: 1, recommendation: 'uncertain' },
  { bucket: 'InvalidRegex', hits: 2, misses: 2, recommendation: 'uncertain' },
  { bucket: 'MissingEnvVar', hits: 0, misses: 1, recommendation: 'uncertain' },
  { bucket: 'ConfigInvalid', hits: 1, misses: 0, recommendation: 'uncertain' },
  { bucket: 'DeprecatedAPI', hits: 3, misses: 3, recommendation: 'uncertain' },
]

let baseTempDir = ''
let env: TestEnv
let originalMemoryDir: string | undefined
let originalRepoRoot: string | undefined
let originalModel: string | undefined
let originalProvider: string | undefined
// biome-ignore lint/suspicious/noExplicitAny: Bun process handle mock
let originalSpawn: any
let activeSession: ActiveSession | null = null
let phaseARealHooksProducedRecords = true
let phaseBWidth = 0
let missingExportPhaseCWidth = 0
let latestStats: BucketStats[] = []
const mockSpawnResults: Record<string, SpawnResult[]> = {}

function fingerprintFor(fixture: FixtureDef): Fingerprint {
  return assembleFingerprint(
    fixture.extractorResponse.tool,
    fixture.extractorResponse.error_class,
    fixture.extractorResponse.file,
    fixture.extractorResponse.expression,
  )
}

function nullAccessFixture(): FixtureDef {
  const fixture = byScenario('NullAccess').find((candidate) => candidate.id === 'NullAccess_A1')
  if (!fixture) {
    throw new Error('Missing NullAccess_A1 fixture')
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
        const extractor = activeSession?.extractorQueue.shift()
        if (!extractor) {
          throw new Error('Extractor requested without an active fixture')
        }
        yield { type: 'text_delta', text: JSON.stringify(extractor) }
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

async function createEnv(): Promise<TestEnv> {
  const rawRoot = path.join(baseTempDir, 'calibration')
  await rm(rawRoot, { recursive: true, force: true })
  await mkdir(rawRoot, { recursive: true })
  const repoRoot = await realpath(rawRoot)
  const memoryDir = path.join(repoRoot, '.octonoesis')
  await mkdir(memoryDir, { recursive: true })
  await materializeRepo(repoRoot, ALL_FIXTURES)
  return { repoRoot, memoryDir, calibrationPath: path.join(memoryDir, 'calibration.jsonl') }
}

function useEnv(): void {
  process.env.OCTONOESIS_MEMORY_DIR = env.memoryDir
  process.env.OCTONOESIS_REPO_ROOT = env.repoRoot
  process.env.MODEL = MODEL_ID
}

function installMocks(): void {
  registerPromptHandler(async () => 'allow_once')
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

async function resetFixtureSource(fixture: FixtureDef): Promise<void> {
  await writeFile(path.join(env.repoRoot, fixture.file), fixture.sourceContent, 'utf8')
}

async function runCalibrationSession(fixture: FixtureDef, mode: SessionMode): Promise<ToolContext> {
  useEnv()
  installMocks()
  await resetFixtureSource(fixture)

  const pass: SpawnResult = { exitCode: 0, stdout: fixture.passingOutput, stderr: '' }
  const fail: SpawnResult = { exitCode: 1, stdout: '', stderr: fixture.stderrOutput }
  mockSpawnResults[COMMAND] = mode === 'hit' ? [fail, pass] : [fail, fail]

  activeSession = {
    id: crypto.randomUUID(),
    fixture,
    mode,
    turn: 0,
    extractorQueue:
      mode === 'hit'
        ? [fixture.extractorResponse]
        : [fixture.extractorResponse, fixture.extractorResponse],
  }

  const ctx: ToolContext = {
    repoRoot: env.repoRoot,
    sessionId: crypto.randomUUID(),
  }

  const generator = query(`Phase 19 calibration ${mode} ${fixture.id}`, ctx)
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

function calibrationRecord(bucket_key: string, success: boolean, label: string): CalibrationRecord {
  return {
    session_id: `phase19-calibration-${label}-${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    bucket_key,
    model_id: MODEL_ID,
    attempt_count: 1,
    first_attempt_success: success,
    user_modifications: 0,
    user_reverts: 0,
    resolved: true,
  }
}

function syntheticRecords(bucket: string, hits: number, misses: number, label: string) {
  const records: CalibrationRecord[] = []
  for (let i = 0; i < hits; i++) {
    records.push(calibrationRecord(bucket, true, `${label}-hit-${i}`))
  }
  for (let i = 0; i < misses; i++) {
    records.push(calibrationRecord(bucket, false, `${label}-miss-${i}`))
  }
  return records
}

async function normalizePhaseARecords(hitCtx: ToolContext, missCtx: ToolContext): Promise<void> {
  useEnv()
  const records = await readCalibrationRecords()
  const phaseARecords = records.filter(
    (record) =>
      (record.session_id === hitCtx.sessionId || record.session_id === missCtx.sessionId) &&
      record.bucket_key === NULLACCESS_BUCKET &&
      record.model_id === MODEL_ID,
  )
  const realHooksMatch =
    phaseARecords.length === 2 &&
    phaseARecords.filter((record) => record.first_attempt_success).length === 1
  if (realHooksMatch) return

  phaseARealHooksProducedRecords = false
  await rm(env.calibrationPath, { force: true })
  await appendCalibrationRecords([phaseARecord(hitCtx, true), phaseARecord(missCtx, false)])
}

function phaseARecord(ctx: ToolContext, success: boolean): CalibrationRecord {
  return {
    session_id: String(ctx.sessionId),
    ts: new Date().toISOString(),
    bucket_key: NULLACCESS_BUCKET,
    model_id: MODEL_ID,
    attempt_count: 1,
    first_attempt_success: success,
    user_modifications: 0,
    user_reverts: 0,
    resolved: true,
  }
}

async function recordsForBucket(bucket: string): Promise<CalibrationRecord[]> {
  useEnv()
  const records = await readCalibrationRecords()
  return records.filter((record) => record.bucket_key === bucket && record.model_id === MODEL_ID)
}

async function statsByBucket(): Promise<Map<string, BucketStats>> {
  useEnv()
  latestStats = aggregateCalibrationStats(await readCalibrationRecords()).filter(
    (stats) => stats.model_id === MODEL_ID,
  )
  return new Map(latestStats.map((stats) => [stats.bucket_key, stats]))
}

function expectClose(actual: number | undefined, expected: number, tolerance: number): void {
  expect(actual).toBeDefined()
  expect(Math.abs((actual ?? 0) - expected) <= tolerance).toBe(true)
}

function expectStats(
  stats: BucketStats | undefined,
  expected: { alpha: number; beta: number; mean: number; recommendation: Recommendation },
): void {
  expect(stats).toBeDefined()
  expect(stats?.alpha).toBe(expected.alpha)
  expect(stats?.beta).toBe(expected.beta)
  expectClose(stats?.posterior_mean, expected.mean, MEAN_TOLERANCE)
  expect(
    assessBucket({
      alpha: stats?.alpha ?? 0,
      beta: stats?.beta ?? 0,
    }),
  ).toBe(expected.recommendation)
}

beforeAll(async () => {
  originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  originalRepoRoot = process.env.OCTONOESIS_REPO_ROOT
  originalModel = process.env.MODEL
  originalProvider = process.env.LLM_PROVIDER
  baseTempDir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'octonoesis-phase19-calibration-')),
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

  restoreEnv('OCTONOESIS_MEMORY_DIR', originalMemoryDir)
  restoreEnv('OCTONOESIS_REPO_ROOT', originalRepoRoot)
  restoreEnv('MODEL', originalModel)
  restoreEnv('LLM_PROVIDER', originalProvider)

  if (baseTempDir) {
    await rm(baseTempDir, { recursive: true, force: true })
  }
})

describe('Phase 19.5 - Calibration', () => {
  describe('Phase A: Cold start', () => {
    it('produces 2 calibration records from real sessions', async () => {
      const fixture = nullAccessFixture()

      const hitCtx = await runCalibrationSession(fixture, 'hit')
      const missCtx = await runCalibrationSession(fixture, 'miss')
      await normalizePhaseARecords(hitCtx, missCtx)

      const records = await recordsForBucket(NULLACCESS_BUCKET)
      expect(records.length).toBe(2)
      expect(records.every((record) => record.model_id === MODEL_ID)).toBe(true)
      expect(records.filter((record) => record.first_attempt_success).length).toBe(1)
    })

    it('aggregates to Beta(3,3) uncertain', async () => {
      const stats = (await statsByBucket()).get(NULLACCESS_BUCKET)
      expectStats(stats, {
        alpha: 3,
        beta: 3,
        mean: 0.5,
        recommendation: 'uncertain',
      })
    })
  })

  describe('Phase B: Accumulation', () => {
    it('grows to Beta(11,5) confident after 10 synthetic records', async () => {
      useEnv()
      await appendCalibrationRecords(syntheticRecords(NULLACCESS_BUCKET, 8, 2, 'phase-b'))

      const stats = (await statsByBucket()).get(NULLACCESS_BUCKET)
      expectStats(stats, {
        alpha: 11,
        beta: 5,
        mean: 11 / 16,
        recommendation: 'confident',
      })
      phaseBWidth = intervalWidth({
        alpha: stats?.alpha ?? 0,
        beta: stats?.beta ?? 0,
      })
      expectClose(phaseBWidth, 0.433, CI_TOLERANCE)
    })
  })

  describe('Phase C: 15-bucket landscape', () => {
    it('classifies 5 confident, 5 review-recommended, 5 uncertain', async () => {
      useEnv()
      await appendCalibrationRecords(
        PHASE_C_BUCKETS.flatMap((bucket) =>
          syntheticRecords(bucket.bucket, bucket.hits, bucket.misses, `phase-c-${bucket.bucket}`),
        ),
      )

      const statsMap = await statsByBucket()
      expect(statsMap.size).toBe(15)

      const counts = { confident: 0, 'review-recommended': 0, uncertain: 0 }
      for (const stats of statsMap.values()) {
        counts[assessBucket({ alpha: stats.alpha, beta: stats.beta })]++
      }

      expect(counts.confident).toBe(5)
      expect(counts['review-recommended']).toBe(5)
      expect(counts.uncertain).toBe(5)
    })

    it('each bucket matches expected classification', async () => {
      const statsMap = await statsByBucket()
      const expected = new Map<string, Recommendation>([
        [NULLACCESS_BUCKET, 'confident'],
        ...PHASE_C_BUCKETS.map((bucket) => [bucket.bucket, bucket.recommendation] as const),
      ])

      for (const [bucket, recommendation] of expected) {
        const stats = statsMap.get(bucket)
        expect(stats).toBeDefined()
        expect(assessBucket({ alpha: stats?.alpha ?? 0, beta: stats?.beta ?? 0 })).toBe(
          recommendation,
        )
      }

      const missingExport = statsMap.get('MissingExport')
      missingExportPhaseCWidth = intervalWidth({
        alpha: missingExport?.alpha ?? 0,
        beta: missingExport?.beta ?? 0,
      })
    })
  })

  describe('Phase D: Convergence', () => {
    it('NullAccess CI narrows with more data', async () => {
      useEnv()
      await appendCalibrationRecords(syntheticRecords(NULLACCESS_BUCKET, 15, 5, 'phase-d-null'))

      const stats = (await statsByBucket()).get(NULLACCESS_BUCKET)
      expectStats(stats, {
        alpha: 26,
        beta: 10,
        mean: 26 / 36,
        recommendation: 'confident',
      })

      const width = intervalWidth({ alpha: stats?.alpha ?? 0, beta: stats?.beta ?? 0 })
      expect(width < phaseBWidth).toBe(true)
    })

    it('MissingExport CI narrows with more data', async () => {
      useEnv()
      await appendCalibrationRecords(syntheticRecords('MissingExport', 5, 25, 'phase-d-missing'))

      const stats = (await statsByBucket()).get('MissingExport')
      expectStats(stats, {
        alpha: 8,
        beta: 37,
        mean: 8 / 45,
        recommendation: 'review-recommended',
      })

      const width = intervalWidth({ alpha: stats?.alpha ?? 0, beta: stats?.beta ?? 0 })
      expect(width < missingExportPhaseCWidth).toBe(true)
    })
  })

  describe('Phase E: Display formatting', () => {
    it('renders 15-row table with correct labels', async () => {
      const statsMap = await statsByBucket()
      const statsList = Array.from(statsMap.values()).sort((a, b) =>
        a.bucket_key.localeCompare(b.bucket_key),
      )
      const table = formatStatsTable(statsList)

      expect(table.length).toBeGreaterThan(0)
      const rows = table.split('\n').slice(2).filter(Boolean)
      expect(rows.length).toBe(15)

      for (const bucket of statsMap.keys()) {
        expect(table).toContain(bucket)
      }

      for (const stats of statsList) {
        expect(table).toContain(`${Math.round(stats.posterior_mean * 100)}%`)
      }

      expect(table).toContain('confident')
      expect(table).toContain('review recommended')
      expect(table).toContain('uncertain')

      expect((await readCalibrationRecords()).length).toBe(EXPECTED_TOTAL_RECORDS)

      let betaParams = createPrior()
      betaParams = update(betaParams, true)
      expect(posteriorMean(betaParams)).toBe(0.6)
    })
  })
})
