import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Episode } from '../../src/memory/episodes/types.ts'
import { assembleFingerprint } from '../../src/memory/fingerprint/extract.ts'
import { distillEpisode } from '../../src/memory/rules/distill.ts'
import { formatMatchAdvice } from '../../src/memory/rules/match.ts'
import type { RuleFile } from '../../src/memory/rules/types.ts'
import { getCheapestModel, getProvider } from '../../src/providers/index.ts'
import type { CanonicalMessage, Usage } from '../../src/providers/types.ts'
import {
  ALL_FIXTURES,
  type FixtureDef,
  type SCENARIO_TYPES,
} from '../fixtures/learning-demo/fixtures.ts'

type ScenarioType = (typeof SCENARIO_TYPES)[number]

type CliOptions = {
  runs: number
  types: ScenarioType[]
  verbose: boolean
  help: boolean
  model: string | null
  distillModel: string | null
}

type TestRun = {
  exitCode: number
  stdout: string
  stderr: string
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

type FixEdit = {
  file: string
  old: string
  new: string
}

type SessionResult = {
  turns: number
  inputTokens: number
  outputTokens: number
  success: boolean
  apiError: boolean
  initialStderr: string
  successfulEdit?: FixEdit
}

type PairResult = {
  type: ScenarioType
  fixtureId: string
  run: number
  control: SessionResult
  treatment: SessionResult
  ruleUsed: boolean
  distillFailed: boolean
}

type Summary = {
  controlTurns: number[]
  treatmentTurns: number[]
  controlInput: number[]
  treatmentInput: number[]
  controlOutput: number[]
  treatmentOutput: number[]
  controlSuccesses: number
  treatmentSuccesses: number
}

const DEFAULT_TYPES: ScenarioType[] = [
  'NullAccess',
  'ParseError',
  'ModuleNotFound',
  'ExpectMismatch',
  'UndefinedRef',
]
const EXTRACTOR_VERSION = '0.3.0'
const MAX_TURNS = 5
const realSpawn = (globalThis as typeof globalThis & { Bun: { spawn: BunSpawn } }).Bun.spawn
const FIX_SYSTEM_PROMPT = `You are a coding agent. Your job is to fix a failing test by editing a source file.
You MUST respond with ONLY a JSON object, no other text:
{"file": "<repo-relative path>", "old": "<exact substring to replace>", "new": "<replacement>"}
The "old" value must be an exact substring of the current source file contents.`

const EXPECTED_BY_FIXTURE: Record<string, string> = {
  ExpectMismatch_A1: '6',
  ExpectMismatch_A2: '2',
  ExpectMismatch_A3: "'TITLE'",
  ExpectMismatch_B1: "'$4.00'",
  ExpectMismatch_B2: "'007'",
  ExpectMismatch_B3: '4000',
  ExpectMismatch_C1: '39.2',
  ExpectMismatch_C2: '5',
  ExpectMismatch_D1: '50',
  ExpectMismatch_E1: '6',
}

function printHelp(): void {
  console.log(`Usage: bun run test/demo/live-ab.ts [options]

Options:
  --runs N            Number of runs per bug type (default: 10, minimum: 2)
  --types T           Comma-separated bug types (default: all 5)
  --verbose           Print per-run details
  --model ID          Solver model used to attempt fixes (default: cheapest model for
                       the resolved provider, i.e. getCheapestModel())
  --distill-model ID  Distiller model used to write rules from resolved episodes
                       (default: cheapest model for the resolved provider, i.e.
                       getCheapestModel())
  --help              Show this help`)
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    runs: 10,
    types: DEFAULT_TYPES,
    verbose: false,
    help: false,
    model: null,
    distillModel: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help') {
      options.help = true
    } else if (arg === '--verbose') {
      options.verbose = true
    } else if (arg === '--runs') {
      const value = argv[++i]
      const runs = Number(value)
      if (!Number.isInteger(runs) || runs < 2) {
        throw new Error('--runs must be an integer >= 2')
      }
      options.runs = runs
    } else if (arg === '--types') {
      const value = argv[++i]
      if (!value) {
        throw new Error('--types requires a comma-separated value')
      }
      options.types = value.split(',').map(parseScenarioType)
    } else if (arg === '--model') {
      const value = argv[++i]
      if (!value) {
        throw new Error('--model requires a value')
      }
      options.model = value
    } else if (arg === '--distill-model') {
      const value = argv[++i]
      if (!value) {
        throw new Error('--distill-model requires a value')
      }
      options.distillModel = value
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

function parseScenarioType(value: string): ScenarioType {
  const trimmed = value.trim()
  if (!DEFAULT_TYPES.includes(trimmed as ScenarioType)) {
    throw new Error(`Unsupported type "${trimmed}". Supported: ${DEFAULT_TYPES.join(', ')}`)
  }
  return trimmed as ScenarioType
}

function fixturesForType(type: ScenarioType): FixtureDef[] {
  const fixtures = ALL_FIXTURES.filter((fixture) => fixture.scenarioType === type)
  if (fixtures.length === 0) {
    throw new Error(`No fixtures found for ${type}`)
  }
  return fixtures
}

async function setupEnv(
  fixture: FixtureDef,
  label: string,
): Promise<{ repoRoot: string; testFile: string }> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), `octonoesis-live-ab-${label}-`))
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ name: 'octonoesis-live-ab', type: 'module', private: true }, null, 2),
    'utf8',
  )
  await writeFile(
    path.join(repoRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  const sourcePath = path.join(repoRoot, fixture.file)
  await mkdir(path.dirname(sourcePath), { recursive: true })
  await writeFile(sourcePath, fixture.sourceContent, 'utf8')
  await writeModuleForFixedImport(repoRoot, fixture)

  const testFile = fixture.file.replace(/\.ts$/, '.test.ts')
  const testPath = path.join(repoRoot, testFile)
  await mkdir(path.dirname(testPath), { recursive: true })
  await writeFile(testPath, buildTestFile(fixture), 'utf8')

  return { repoRoot, testFile }
}

async function writeModuleForFixedImport(repoRoot: string, fixture: FixtureDef): Promise<void> {
  if (fixture.scenarioType !== 'ModuleNotFound') return

  const match = fixture.fix.new.match(/import\s+\{\s*([A-Za-z_$][\w$]*)\s*\}\s+from\s+['"](.+)['"]/)
  if (!match) return

  const exportedName = match[1]
  const modulePath = match[2]
  const target = path.join(path.dirname(path.join(repoRoot, fixture.file)), `${modulePath}.ts`)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(
    target,
    `export function ${exportedName}(raw = 'ok'): string {\n  return raw\n}\n`,
    'utf8',
  )
}

function buildTestFile(fixture: FixtureDef): string {
  const moduleName = `./${path.basename(fixture.file, '.ts')}`
  const handleName = getHandleExport(fixture)
  const title = `${fixture.scenarioType} ${fixture.id}`

  if (fixture.scenarioType === 'NullAccess') {
    return `import { describe, it } from 'bun:test'
import * as mod from '${moduleName}'

describe('${title}', () => {
  it('reproduces fixture failure', () => {
    mod.${handleName}(null as any)
  })
})
`
  }

  if (fixture.scenarioType === 'ParseError') {
    return `import { describe, expect, it } from 'bun:test'
import * as mod from '${moduleName}'

describe('${title}', () => {
  it('loads parser module', () => {
    expect(Object.keys(mod).length).toBeGreaterThan(0)
  })
})
`
  }

  if (fixture.scenarioType === 'ModuleNotFound') {
    return `import { describe, expect, it } from 'bun:test'
import * as mod from '${moduleName}'

describe('${title}', () => {
  it('loads module dependencies', () => {
    expect(mod.${handleName}).toBeDefined()
  })
})
`
  }

  if (fixture.scenarioType === 'ExpectMismatch') {
    const expected = EXPECTED_BY_FIXTURE[fixture.id]
    if (!expected) {
      throw new Error(`No expected value configured for ${fixture.id}`)
    }
    return `import { describe, expect, it } from 'bun:test'
import * as mod from '${moduleName}'

describe('${title}', () => {
  it('matches expected value', () => {
    ;(globalThis as any).total = 10
    ;(globalThis as any).discount = 8
    ;(globalThis as any).title = 'title'
    ;(globalThis as any).amount = 4
    ;(globalThis as any).value = '7'
    ;(globalThis as any).meters = 4
    ;(globalThis as any).celsius = 4
    ;(globalThis as any).items = [1, 2]
    ;(globalThis as any).correct = 5
    ;(globalThis as any).base = 4
    ;(globalThis as any).bonus = 2
    expect(mod.${handleName}()).toBe(${expected})
  })
})
`
  }

  if (fixture.scenarioType === 'UndefinedRef') {
    return `import { describe, it } from 'bun:test'
import * as mod from '${moduleName}'

describe('${title}', () => {
  it('resolves context value', () => {
    mod.${handleName}('value', {
      currentUserId: 'currentUserId',
      activeScopeName: 'activeScopeName',
      requestTraceId: 'requestTraceId',
      sessionRoleName: 'sessionRoleName',
      tenantRegion: 'tenantRegion',
      resolvedModuleName: 'resolvedModuleName',
      entryAlias: 'entryAlias',
      boundServiceName: 'boundServiceName',
      injectedSecretToken: 'injectedSecretToken',
      dependencyPath: 'dependencyPath',
    })
  })
})
`
  }

  throw new Error(`No test generator for ${fixture.scenarioType}`)
}

function getHandleExport(fixture: FixtureDef): string {
  const matches = [
    ...fixture.sourceContent.matchAll(/export (?:async )?function ([A-Za-z_$][\w$]*)\(/g),
  ].flatMap((match) => {
    const name = match[1]
    return name ? [name] : []
  })
  const handle = matches.find((name) => name.startsWith('handle'))
  const fallback = matches[0]
  if (handle) return handle
  if (fallback) return fallback
  throw new Error(`No exported function found in ${fixture.id}`)
}

async function runBunTest(repoRoot: string, testFile: string): Promise<TestRun> {
  const proc = realSpawn({
    cmd: ['bun', 'test', testFile],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(''),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
  ])
  return { exitCode, stdout, stderr }
}

async function runSession(
  repoRoot: string,
  testFile: string,
  fixture: FixtureDef,
  ruleAdvice: string | null,
  solverModel: string,
): Promise<SessionResult> {
  const sourcePath = path.join(repoRoot, fixture.file)
  let testRun = await runBunTest(repoRoot, testFile)
  let stderr = testRun.stderr || testRun.stdout
  const initialStderr = stderr
  let turns = 0
  let inputTokens = 0
  let outputTokens = 0
  let apiError = false
  let lastEdit: FixEdit | undefined

  while (turns < MAX_TURNS) {
    if (testRun.exitCode === 0) {
      return {
        turns,
        inputTokens,
        outputTokens,
        success: true,
        apiError,
        initialStderr,
        successfulEdit: lastEdit,
      }
    }

    turns++
    const sourceContent = await readFile(sourcePath, 'utf8')
    const response = await callFixLLM(
      buildFixPrompt(stderr, sourceContent, fixture, ruleAdvice),
      solverModel,
    )
    if (!response.ok) {
      apiError = true
      return {
        turns: MAX_TURNS,
        inputTokens,
        outputTokens,
        success: false,
        apiError,
        initialStderr,
      }
    }

    inputTokens += response.usage.input_tokens
    outputTokens += response.usage.output_tokens
    const fix = parseFixResponse(response.text, sourceContent, fixture)
    if (!fix) {
      return { turns, inputTokens, outputTokens, success: false, apiError, initialStderr }
    }

    lastEdit = fix
    await writeFile(sourcePath, sourceContent.replace(fix.old, fix.new), 'utf8')
    testRun = await runBunTest(repoRoot, testFile)
    stderr = testRun.stderr || testRun.stdout
  }

  return { turns, inputTokens, outputTokens, success: false, apiError, initialStderr }
}

function buildFixPrompt(
  stderr: string,
  sourceContent: string,
  fixture: FixtureDef,
  ruleAdvice: string | null,
): string {
  const ruleBlock = ruleAdvice
    ? `
Relevant rule from past experience:
---
${ruleAdvice}
---
`
    : ''

  return `Test failure output:
---
${stderr}
---

Source file (${fixture.file}):
---
${sourceContent}
---
${ruleBlock}
Fix the bug. Respond with ONLY the JSON edit object.`
}

async function callFixLLM(
  prompt: string,
  solverModel: string,
): Promise<{ ok: true; text: string; usage: Usage } | { ok: false }> {
  try {
    return await retryOnce(async () => {
      const provider = getProvider()
      const messages: CanonicalMessage[] = [{ role: 'user', content: prompt }]
      const stream = provider.createMessageStream(messages, [], {
        model: solverModel,
        maxTokens: 1200,
        signal: new AbortController().signal,
        system: FIX_SYSTEM_PROMPT,
      })
      let text = ''
      let usage: Usage = { input_tokens: 0, output_tokens: 0 }
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          text += event.text
        } else if (event.type === 'message_end') {
          usage = event.usage
        }
      }
      return { ok: true as const, text, usage }
    })
  } catch (error) {
    console.error(
      `LLM call failed after retry: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { ok: false }
  }
}

async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    return await fn()
  }
}

function parseFixResponse(
  text: string,
  sourceContent: string,
  fixture: FixtureDef,
): FixEdit | null {
  let cleaned = text.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  cleaned = cleaned.slice(start, end + 1)

  try {
    const parsed = JSON.parse(cleaned) as Partial<FixEdit>
    const file = typeof parsed.file === 'string' ? parsed.file.replace(/^\.\//, '') : ''
    const oldValue = typeof parsed.old === 'string' ? parsed.old : ''
    const newValue = typeof parsed.new === 'string' ? parsed.new : ''
    if (file !== fixture.file) return null
    if (!oldValue || !sourceContent.includes(oldValue)) return null
    if (oldValue === newValue) return null
    return { file, old: oldValue, new: newValue }
  } catch {
    return null
  }
}

async function runPair(
  type: ScenarioType,
  run: number,
  fixture: FixtureDef,
  solverModel: string,
  distillModel: string,
): Promise<PairResult> {
  let controlEnv: { repoRoot: string; testFile: string } | null = null
  let treatmentEnv: { repoRoot: string; testFile: string } | null = null
  let rule: RuleFile | null = null
  let distillFailed = false

  try {
    controlEnv = await setupEnv(fixture, `${type}-${run}-control`)
    const control = await runSession(
      controlEnv.repoRoot,
      controlEnv.testFile,
      fixture,
      null,
      solverModel,
    )

    if (control.success) {
      try {
        const evidence = control.successfulEdit
          ? {
              errorExcerpt: control.initialStderr,
              fixDiff: `${control.successfulEdit.old} -> ${control.successfulEdit.new}`,
            }
          : undefined
        rule = await distillEpisode(
          buildEpisode(type, run, fixture, control, controlEnv.testFile),
          {
            model: distillModel,
            extractorVersion: EXTRACTOR_VERSION,
            ...(evidence ? { evidence } : {}),
          },
        )
      } catch (error) {
        distillFailed = true
        console.error(
          `Distillation failed for ${fixture.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const fingerprint = fingerprintFor(fixture)
    const advice = rule ? formatMatchAdvice({ rule, fingerprint, level: 'fine' }) : null
    treatmentEnv = await setupEnv(fixture, `${type}-${run}-treatment`)
    const treatment = await runSession(
      treatmentEnv.repoRoot,
      treatmentEnv.testFile,
      fixture,
      advice,
      solverModel,
    )

    return {
      type,
      fixtureId: fixture.id,
      run,
      control,
      treatment,
      ruleUsed: Boolean(rule),
      distillFailed,
    }
  } finally {
    if (controlEnv) await rm(controlEnv.repoRoot, { recursive: true, force: true })
    if (treatmentEnv) await rm(treatmentEnv.repoRoot, { recursive: true, force: true })
  }
}

function buildEpisode(
  type: ScenarioType,
  run: number,
  fixture: FixtureDef,
  control: SessionResult,
  testFile: string,
): Episode {
  const fp = fingerprintFor(fixture)
  return {
    id: `ep_ab_${type}_${run}`,
    timestamp: new Date().toISOString(),
    session_id: `ab_control_${type}_${run}`,
    task_digest: `Fix ${fixture.errorClass} in ${fixture.file}`,
    failure: {
      tool: 'Bash',
      cmd: `bun test ${testFile}`,
      error_class: fixture.errorClass,
      signature: fp.fine,
    },
    fix_candidates: [
      {
        tool: 'Edit',
        path: fixture.file,
        summary: `Fix ${fixture.errorClass}`,
        role: 'direct',
      },
    ],
    attribution: { status: 'single_direct', primary: fixture.file, confidence: 1.0 },
    verification: { cmd: `bun test ${testFile}`, exit_code: control.success ? 0 : 1 },
    outcome: control.success ? 'resolved' : 'abandoned',
    journal_line_range: { start: 1, end: 1 },
    value_score: control.success ? 1.0 : 0.0,
    is_excluded: false,
    exclusion_reason: null,
  }
}

function fingerprintFor(fixture: FixtureDef) {
  return assembleFingerprint(
    fixture.extractorResponse.tool,
    fixture.extractorResponse.error_class,
    fixture.extractorResponse.file,
    fixture.extractorResponse.expression,
  )
}

function summarize(results: PairResult[]): Summary {
  return {
    controlTurns: results.map((result) => result.control.turns),
    treatmentTurns: results.map((result) => result.treatment.turns),
    controlInput: results.map((result) => result.control.inputTokens),
    treatmentInput: results.map((result) => result.treatment.inputTokens),
    controlOutput: results.map((result) => result.control.outputTokens),
    treatmentOutput: results.map((result) => result.treatment.outputTokens),
    controlSuccesses: results.filter((result) => result.control.success).length,
    treatmentSuccesses: results.filter((result) => result.treatment.success).length,
  }
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const avg = mean(values)
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1))
}

function formatMean(values: number[], digits = 1): string {
  return `${mean(values).toFixed(digits)} \u00b1 ${stddev(values).toFixed(digits)}`
}

function formatDelta(control: number[], treatment: number[]): string {
  const controlMean = mean(control)
  if (controlMean === 0) return '\u2014'
  const deltas = control.map((value, index) => {
    const treatmentValue = treatment[index]
    if (treatmentValue === undefined) {
      throw new Error('Mismatched paired samples')
    }
    return ((treatmentValue - value) / value) * 100
  })
  const avg = mean(deltas)
  const spread = stddev(deltas)
  return `${avg >= 0 ? '+' : ''}${avg.toFixed(0)}% \u00b1 ${spread.toFixed(0)}%`
}

function pairedTTest(control: number[], treatment: number[]): { t: number; p: number } {
  const diffs = control.map((value, index) => {
    const treatmentValue = treatment[index]
    if (treatmentValue === undefined) {
      throw new Error('Mismatched paired samples')
    }
    return value - treatmentValue
  })
  const n = diffs.length
  if (n < 2) return { t: 0, p: 1 }
  const avg = mean(diffs)
  const variance = diffs.reduce((sum, diff) => sum + (diff - avg) ** 2, 0) / (n - 1)
  const se = Math.sqrt(variance / n)
  if (se === 0) return { t: avg === 0 ? 0 : Number.POSITIVE_INFINITY, p: avg === 0 ? 1 : 0 }
  const t = avg / se
  const p = 2 * (1 - normalCDF(Math.abs(t)))
  return { t, p: Math.max(0, Math.min(1, p)) }
}

function normalCDF(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2
  const t = 1.0 / (1.0 + p * z)
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z)
  return 0.5 * (1.0 + sign * y)
}

function printTypeReport(type: ScenarioType, results: PairResult[]): void {
  const summary = summarize(results)
  console.log(`\n=== ${type} - ${results.length} runs ===`)
  console.log('| Metric          | Control       | Treatment     | Delta        |')
  console.log('|-----------------|---------------|---------------|--------------|')
  console.log(
    `| Turns           | ${pad(formatMean(summary.controlTurns))} | ${pad(formatMean(summary.treatmentTurns))} | ${pad(formatDelta(summary.controlTurns, summary.treatmentTurns))} |`,
  )
  console.log(
    `| Tokens (input)  | ${pad(formatMean(summary.controlInput, 0))} | ${pad(formatMean(summary.treatmentInput, 0))} | ${pad(formatDelta(summary.controlInput, summary.treatmentInput))} |`,
  )
  console.log(
    `| Tokens (output) | ${pad(formatMean(summary.controlOutput, 0))} | ${pad(formatMean(summary.treatmentOutput, 0))} | ${pad(formatDelta(summary.controlOutput, summary.treatmentOutput))} |`,
  )
  console.log(
    `| Success rate    | ${pad(`${summary.controlSuccesses}/${results.length}`)} | ${pad(`${summary.treatmentSuccesses}/${results.length}`)} | ${pad('\u2014')} |`,
  )
}

function printOverallReport(results: PairResult[], typeCount: number, runs: number): void {
  const summary = summarize(results)
  const turnsT = pairedTTest(summary.controlTurns, summary.treatmentTurns)
  const inputT = pairedTTest(summary.controlInput, summary.treatmentInput)
  const outputT = pairedTTest(summary.controlOutput, summary.treatmentOutput)

  console.log(`\n=== Overall (${typeCount} types x ${runs} runs = ${results.length} pairs) ===`)
  console.log('| Metric          | Control       | Treatment     | Delta        | p-value  |')
  console.log('|-----------------|---------------|---------------|--------------|----------|')
  console.log(
    `| Turns           | ${pad(formatMean(summary.controlTurns))} | ${pad(formatMean(summary.treatmentTurns))} | ${pad(formatDelta(summary.controlTurns, summary.treatmentTurns))} | ${padP(turnsT.p)} |`,
  )
  console.log(
    `| Tokens (input)  | ${pad(formatMean(summary.controlInput, 0))} | ${pad(formatMean(summary.treatmentInput, 0))} | ${pad(formatDelta(summary.controlInput, summary.treatmentInput))} | ${padP(inputT.p)} |`,
  )
  console.log(
    `| Tokens (output) | ${pad(formatMean(summary.controlOutput, 0))} | ${pad(formatMean(summary.treatmentOutput, 0))} | ${pad(formatDelta(summary.controlOutput, summary.treatmentOutput))} | ${padP(outputT.p)} |`,
  )
  console.log(
    `| Success rate    | ${pad(`${summary.controlSuccesses}/${results.length}`)} | ${pad(`${summary.treatmentSuccesses}/${results.length}`)} | ${pad('\u2014')} | ${padP(null)} |`,
  )
}

function pad(value: string, width = 13): string {
  return value.padEnd(width, ' ')
}

function padP(value: number | null): string {
  return (value === null ? '\u2014' : value.toFixed(3)).padEnd(8, ' ')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const resolvedProvider = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase()
  if (resolvedProvider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      console.error('OPENAI_API_KEY is required to run live A/B demo sessions with LLM_PROVIDER=openai.')
      process.exitCode = 1
      return
    }
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is required to run live A/B demo sessions.')
      process.exitCode = 1
      return
    }
  }

  getProvider()
  const solverModel = options.model ?? getCheapestModel()
  const distillModel = options.distillModel ?? getCheapestModel()
  console.log(
    `Provider: ${resolvedProvider} | Solver model: ${solverModel} | Distill model: ${distillModel}`,
  )
  const allResults: PairResult[] = []
  let apiErrorRuns = 0
  let distillFailures = 0

  for (const type of options.types) {
    const fixtures = fixturesForType(type)
    const typeResults: PairResult[] = []
    for (let run = 0; run < options.runs; run++) {
      const fixture = fixtures[run % fixtures.length]
      if (!fixture) {
        throw new Error(`No fixture selected for ${type} run ${run}`)
      }
      const result = await runPair(type, run, fixture, solverModel, distillModel)
      typeResults.push(result)
      allResults.push(result)
      if (result.control.apiError || result.treatment.apiError) apiErrorRuns++
      if (result.distillFailed) distillFailures++
      if (options.verbose) {
        console.log(
          `${type} run ${run + 1}/${options.runs} ${fixture.id}: control=${result.control.success ? 'pass' : 'fail'}:${result.control.turns} treatment=${result.treatment.success ? 'pass' : 'fail'}:${result.treatment.turns} rule=${result.ruleUsed ? 'yes' : 'no'}`,
        )
      }
    }
    printTypeReport(type, typeResults)
  }

  printOverallReport(allResults, options.types.length, options.runs)
  console.log(
    `\nCompleted ${allResults.length} pairs; API error runs: ${apiErrorRuns}; distillation failures: ${distillFailures}.`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
