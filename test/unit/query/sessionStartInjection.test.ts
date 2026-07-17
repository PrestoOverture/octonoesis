import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadRule, saveRule } from '../../../src/memory/rules/store.ts'
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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-session-start-'))
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

describe('session-start rule injection through the real query() engine (FR-INJ-2)', () => {
  it('surfaces only the broad active repo rule advice in the provider-received system prompt', async () => {
    const broadActiveRule = makeRule({
      id: 'rule-broad-active',
      status: 'active',
      scope: 'repo',
      triggers: { tools: ['Bash'], command_prefix: [], error_signatures: ['bun-test|TypeError'] },
      advice: 'BROAD_ACTIVE_ADVICE_CANARY',
    })
    const fineActiveRule = makeRule({
      id: 'rule-fine-active',
      status: 'active',
      scope: 'repo',
      triggers: {
        tools: ['Bash'],
        command_prefix: [],
        error_signatures: ["bun-test|TypeError|src/buggy.ts|evaluating 'user.name'"],
      },
      advice: 'FINE_ACTIVE_ADVICE_CANARY',
    })
    const broadCandidateRule = makeRule({
      id: 'rule-broad-candidate',
      status: 'candidate',
      scope: 'repo',
      triggers: { tools: ['Bash'], command_prefix: [], error_signatures: ['bun-test|TypeError'] },
      advice: 'BROAD_CANDIDATE_ADVICE_CANARY',
    })

    // Seed the on-disk rule pool the same way production code writes it.
    await saveRule(broadActiveRule)
    await saveRule(fineActiveRule)
    await saveRule(broadCandidateRule)

    const provider = new CapturingProvider()
    setProvider(provider)

    const generator = query('Say hello', { repoRoot, sessionId: 'session-start-rules' })
    let step = await generator.next()
    while (!step.done) {
      step = await generator.next()
    }

    expect(step.value.exit_reason).toBe('completed')
    expect(provider.capturedSystem).toBeDefined()
    expect(provider.capturedSystem).toContain('BROAD_ACTIVE_ADVICE_CANARY')
    expect(provider.capturedSystem).not.toContain('FINE_ACTIVE_ADVICE_CANARY')
    expect(provider.capturedSystem).not.toContain('BROAD_CANDIDATE_ADVICE_CANARY')

    // Session-start injection must not touch the rule pool on disk (no hit/miss accounting):
    // re-load from disk rather than inspecting the local object the engine never saw.
    const persisted = await loadRule('rule-broad-active')
    expect(persisted === null).toBe(false)
    expect(persisted?.hits).toBe(0)
    expect(persisted?.misses).toBe(0)
    expect(persisted?.last_matched_at).toBe(null)
    expect(persisted?.alpha).toBe(broadActiveRule.alpha)
    expect(persisted?.beta).toBe(broadActiveRule.beta)
  })

  it('injects nothing when OCTONOESIS_DISABLE_MEMORY is truthy, even with an eligible rule on disk', async () => {
    const broadActiveRule = makeRule({
      id: 'rule-broad-active',
      status: 'active',
      scope: 'repo',
      advice: 'SHOULD_NOT_APPEAR_WHEN_DISABLED_CANARY',
    })
    await saveRule(broadActiveRule)

    const original = process.env.OCTONOESIS_DISABLE_MEMORY
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    try {
      const provider = new CapturingProvider()
      setProvider(provider)

      const generator = query('Say hello', { repoRoot, sessionId: 'session-start-disabled' })
      let step = await generator.next()
      while (!step.done) {
        step = await generator.next()
      }

      expect(step.value.exit_reason).toBe('completed')
      expect(provider.capturedSystem).toBeDefined()
      expect(provider.capturedSystem).not.toContain('SHOULD_NOT_APPEAR_WHEN_DISABLED_CANARY')
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
      } else {
        process.env.OCTONOESIS_DISABLE_MEMORY = original
      }
    }
  })
})
