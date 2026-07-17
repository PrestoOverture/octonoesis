import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assignArm } from '../../../src/experiments/assignment.ts'
import { appendExperimentRecord } from '../../../src/experiments/registry.ts'
import type { ExperimentRecord } from '../../../src/experiments/schema.ts'
import { saveRule } from '../../../src/memory/rules/store.ts'
import type { RuleFile } from '../../../src/memory/rules/types.ts'
import { setProvider } from '../../../src/providers'
import type {
  CanonicalMessage,
  CanonicalTool,
  LLMProvider,
  StreamEvent as ProviderStreamEvent,
} from '../../../src/providers/types'
import { query } from '../../../src/query/engine'

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let tempDir = ''
let repoRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-experiment-injection-'))
  repoRoot = path.join(tempDir, 'repo')
  memoryDir = path.join(tempDir, 'state')
  await fs.mkdir(repoRoot, { recursive: true })
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
})

afterEach(async () => {
  setProvider(null)
  await fs.rm(tempDir, { recursive: true, force: true })
  if (originalMemoryDir === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  } else {
    process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  }
})

function makeRule(overrides: Partial<RuleFile> & { id: string }): RuleFile {
  return {
    triggers: { tools: ['Bash'], command_prefix: [], error_signatures: ['bun-test|TypeError'] },
    scope: 'repo',
    alpha: 3,
    beta: 2,
    confidence: 0.6,
    evidence: ['ep_0001'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'package.json' },
    status: 'active',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'mock',
    prompt_hash: 'hash',
    created_at: new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: `advice for ${overrides.id}`,
    ...overrides,
  }
}

/** Captures the `system` opt passed to createMessageStream, then completes with no tool use. */
class CapturingProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  capturedSystem: string | undefined

  async *createMessageStream(
    _messages: CanonicalMessage[],
    _tools: CanonicalTool[],
    opts: { system?: string },
  ): AsyncIterable<ProviderStreamEvent> {
    this.capturedSystem = opts.system
    yield { type: 'text_delta', text: 'Done.' }
    yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
  }
}

async function runToCompletion(ctx: Parameters<typeof query>[1], message: string) {
  const generator = query(message, ctx)
  let step = await generator.next()
  while (!step.done) {
    step = await generator.next()
  }
  return step.value
}

const baseExperiment: Omit<ExperimentRecord, 'status'> = {
  schema_version: 1,
  id: 'exp-injection-test',
  registered_at: '2026-07-17T00:00:00.000Z',
  hypothesis: 'Arm B rules beat arm A rules on hit rate.',
  endpoints: { primary: 'hit_rate_by_prompt_hash', secondary: [] },
  test: { method: 'interleaved session-sticky A/B', pass_line: 'p < 0.05' },
  arms: [
    { name: 'A', prompt_hashes: ['hash-arm-a'] },
    { name: 'B', prompt_hashes: ['hash-arm-b'] },
  ],
}

describe('session-sticky experiment arm assignment through the real query() engine', () => {
  it('exposes only the assigned arm plus unclaimed rule advice, and records exactly one assignment across two query() calls sharing a ctx', async () => {
    await saveRule(
      makeRule({ id: 'rule-arm-a', prompt_hash: 'hash-arm-a', advice: 'ARM_A_ADVICE_CANARY' }),
    )
    await saveRule(
      makeRule({ id: 'rule-arm-b', prompt_hash: 'hash-arm-b', advice: 'ARM_B_ADVICE_CANARY' }),
    )
    await saveRule(
      makeRule({
        id: 'rule-unclaimed',
        prompt_hash: 'hash-unclaimed',
        advice: 'UNCLAIMED_ADVICE_CANARY',
      }),
    )

    const registered = await appendExperimentRecord({ ...baseExperiment, status: 'running' })

    const sessionId = 'shared-experiment-session'
    const expectedArm = assignArm(sessionId, registered)
    const expectedArmAdvice = expectedArm === 'A' ? 'ARM_A_ADVICE_CANARY' : 'ARM_B_ADVICE_CANARY'
    const otherArmAdvice = expectedArm === 'A' ? 'ARM_B_ADVICE_CANARY' : 'ARM_A_ADVICE_CANARY'

    const ctx = { repoRoot, sessionId }

    const provider1 = new CapturingProvider()
    setProvider(provider1)
    const result1 = await runToCompletion(ctx, 'Say hello')
    expect(result1.exit_reason).toBe('completed')
    expect(provider1.capturedSystem).toContain(expectedArmAdvice)
    expect(provider1.capturedSystem).toContain('UNCLAIMED_ADVICE_CANARY')
    expect(provider1.capturedSystem).not.toContain(otherArmAdvice)

    // Second query() call sharing the same ctx: same arm's advice, no second assignment write.
    const provider2 = new CapturingProvider()
    setProvider(provider2)
    const result2 = await runToCompletion(ctx, 'Say hello again')
    expect(result2.exit_reason).toBe('completed')
    expect(provider2.capturedSystem).toContain(expectedArmAdvice)
    expect(provider2.capturedSystem).not.toContain(otherArmAdvice)

    const assignmentsContent = await fs.readFile(
      path.join(memoryDir, 'experiment-assignments.jsonl'),
      'utf8',
    )
    const lines = assignmentsContent.trim().split('\n')
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0] ?? '{}')
    expect(parsed.schema_version).toBe(1)
    expect(parsed.session_id).toBe(sessionId)
    expect(parsed.experiment_id).toBe('exp-injection-test')
    expect(parsed.arm).toBe(expectedArm)
  })

  it('leaves rules unfiltered and creates no assignments file when no experiment is running', async () => {
    await saveRule(
      makeRule({
        id: 'rule-broad-active',
        prompt_hash: 'hash-broad',
        advice: 'NO_EXPERIMENT_ADVICE_CANARY',
      }),
    )

    const provider = new CapturingProvider()
    setProvider(provider)
    const result = await runToCompletion(
      { repoRoot, sessionId: 'no-experiment-session' },
      'Say hello',
    )

    expect(result.exit_reason).toBe('completed')
    expect(provider.capturedSystem).toContain('NO_EXPERIMENT_ADVICE_CANARY')

    let exists = true
    try {
      await fs.stat(path.join(memoryDir, 'experiment-assignments.jsonl'))
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })
})
