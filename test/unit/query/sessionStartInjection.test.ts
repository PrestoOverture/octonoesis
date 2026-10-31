import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseJournalEvent } from '../../../src/memory/events'
import { flushJournal } from '../../../src/memory/journal'
import { INSIGHT_MIN_SCORE } from '../../../src/memory/rules/sessionStart'
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
    yield { type: 'message_end', stopReason: 'other', usage: { input_tokens: 1, output_tokens: 1 } }
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

it('injects up to two ranked abstract insights and journals only compiled exposure', async () => {
  const task = 'repair cache invalidation concurrency'
  const rules = [
    makeRule({ id: 'rule-best', task_excerpt: task }),
    makeRule({ id: 'rule-middle', task_excerpt: 'cache invalidation concurrency' }),
    makeRule({ id: 'rule-third', task_excerpt: 'cache invalidation' }),
    makeRule({ id: 'rule-unrelated', task_excerpt: 'render typography colors' }),
  ].map((rule) => ({
    ...rule,
    status: 'candidate' as const,
    insight: `INSIGHT_${rule.id}`,
    advice: 'TRACE_SHOULD_NOT_BE_INJECTED',
    triggers: { ...rule.triggers, error_signatures: ['test|Error|file.ts|detail'] },
  }))
  for (const rule of rules) await saveRule(rule, path.join(memoryDir, 'rules'))
  const provider = new CapturingProvider()
  setProvider(provider)
  const generator = query(task, { repoRoot, sessionId: 'insight-exposure' })
  while (!(await generator.next()).done) {
    /* drain */
  }
  expect(provider.capturedSystem).toContain('INSIGHT_rule-best')
  expect(provider.capturedSystem).toContain('INSIGHT_rule-middle')
  expect(provider.capturedSystem).not.toContain('INSIGHT_rule-third')
  expect(provider.capturedSystem).not.toContain('TRACE_SHOULD_NOT_BE_INJECTED')
  expect(provider.capturedSystem).toContain('never override the current task contract')
  expect(
    (provider.capturedSystem ?? '').indexOf('INSIGHT_rule-best') <
      (provider.capturedSystem ?? '').indexOf('INSIGHT_rule-middle'),
  ).toBe(true)
  await flushJournal()
  const events = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => parseJournalEvent(JSON.parse(line)))
  const exposure = events.find((event) => event?.kind === 'insight_retrieval')
  if (exposure?.kind !== 'insight_retrieval' || !('matches' in exposure))
    throw new Error('No insight exposure event')
  expect(exposure.enabled).toBe(true)
  const matches = exposure.matches as { id: string; score: number }[]
  expect(matches.map((match) => match.id)).toEqual(['rule-best', 'rule-middle'])
  expect(matches.every((match) => match.score >= INSIGHT_MIN_SCORE)).toBe(true)
  expect(exposure.min_score).toBe(INSIGHT_MIN_SCORE)
})

it('disables insight retrieval independently and journals zero exposure', async () => {
  const prior = process.env.OCTONOESIS_DISABLE_INSIGHT_RETRIEVAL
  process.env.OCTONOESIS_DISABLE_INSIGHT_RETRIEVAL = '1'
  try {
    await saveRule(
      makeRule({
        id: 'rule-disabled-insight',
        status: 'candidate',
        task_excerpt: 'cache invalidation',
        insight: 'DISABLED_INSIGHT',
      }),
      path.join(memoryDir, 'rules'),
    )
    const provider = new CapturingProvider()
    setProvider(provider)
    const generator = query('cache invalidation', { repoRoot, sessionId: 'insight-disabled' })
    while (!(await generator.next()).done) {
      /* drain */
    }
    expect(provider.capturedSystem).not.toContain('DISABLED_INSIGHT')
    await flushJournal()
    const events = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const exposure = events.find((event) => event.kind === 'insight_retrieval')
    expect(exposure.enabled).toBe(false)
    expect(exposure.matches).toEqual([])
  } finally {
    if (prior === undefined)
      Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_INSIGHT_RETRIEVAL')
    else process.env.OCTONOESIS_DISABLE_INSIGHT_RETRIEVAL = prior
  }
})
