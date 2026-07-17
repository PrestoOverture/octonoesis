import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { MemoryFile } from '../../../src/memory/auto/types'
import type { RuleFile } from '../../../src/memory/rules/types'
import { DEFAULT_CONTEXT_BUDGET } from '../../../src/prompts/compiler'
import { assembleSessionContext, buildSessionContextSources } from '../../../src/prompts/context'

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let tempDir = ''
let repoRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-context-'))
  repoRoot = path.join(tempDir, 'repo')
  memoryDir = path.join(tempDir, 'state')
  await fs.mkdir(repoRoot, { recursive: true })
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
  if (originalMemoryDir === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  } else {
    process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  }
})

function recalledMemory(): MemoryFile {
  return {
    name: 'preferred-test-style',
    description: 'How tests should be written',
    type: 'user',
    content: 'Prefer observable behavior over implementation details.',
    path: path.join(memoryDir, 'memory', 'preferred-test-style.md'),
    mtime: 1,
  }
}

describe('session context assembly', () => {
  it('builds the exact source ids, channels, and priorities', async () => {
    await fs.writeFile(path.join(repoRoot, 'CLAUDE.md'), 'FOLLOW_PROJECT_CANARY', 'utf8')
    await fs.mkdir(path.join(memoryDir, 'memory'), { recursive: true })
    await fs.writeFile(
      path.join(memoryDir, 'memory', 'MEMORY.md'),
      '- [preferred-test-style](preferred-test-style.md) — How tests should be written',
      'utf8',
    )

    const sources = await buildSessionContextSources(
      { repoRoot },
      'test-model',
      { input_tokens: 3, output_tokens: 2 },
      [recalledMemory()],
    )

    expect(sources.map(({ id, channel, priority }) => ({ id, channel, priority }))).toEqual([
      { id: 'static_prompt', channel: 'systemStable', priority: 'critical' },
      { id: 'claude_md', channel: 'systemStable', priority: 'high' },
      { id: 'memory_index', channel: 'systemStable', priority: 'high' },
      { id: 'relevant_memories', channel: 'preamble', priority: 'medium' },
      { id: 'dynamic_suffix', channel: 'preamble', priority: 'low' },
    ])
    expect(sources[1]?.content.startsWith('## Project Instructions (CLAUDE.md)\n')).toBe(true)
    expect(sources[1]?.content).toContain('FOLLOW_PROJECT_CANARY')
    expect(sources[2]?.content).toContain('[preferred-test-style](preferred-test-style.md)')
    expect(sources[3]?.content).toContain('preferred-test-style (user)')
    expect(sources[3]?.content).toContain('Prefer observable behavior')
  })

  it('omits absent CLAUDE.md, memory, and recall sources', async () => {
    const sources = await buildSessionContextSources(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
    )

    expect(sources.map((source) => source.id)).toEqual(['static_prompt', 'dynamic_suffix'])
  })

  it('reports and truncates an oversized CLAUDE.md through its source budget', async () => {
    const cap = DEFAULT_CONTEXT_BUDGET.perSourceCaps.claude_md
    expect(cap).toBeDefined()
    if (cap === undefined) return
    await fs.writeFile(
      path.join(repoRoot, 'CLAUDE.md'),
      `${'x'.repeat(cap * 4 + 100)}TAIL_CANARY`,
      'utf8',
    )

    const compiled = await assembleSessionContext(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
    )

    expect(compiled.dropped).toContain('claude_md')
    expect(compiled.systemStable).toContain('## Project Instructions (CLAUDE.md)')
    expect(compiled.systemStable).not.toContain('TAIL_CANARY')
  })

  it('produces byte-identical stable system text for identical inputs', async () => {
    await fs.writeFile(path.join(repoRoot, 'CLAUDE.md'), 'STABLE_CLAUDE_CANARY', 'utf8')
    await fs.mkdir(path.join(memoryDir, 'memory'), { recursive: true })
    await fs.writeFile(path.join(memoryDir, 'memory', 'MEMORY.md'), 'STABLE_INDEX_CANARY', 'utf8')

    const first = await assembleSessionContext(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [recalledMemory()],
    )
    const second = await assembleSessionContext(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [recalledMemory()],
    )

    expect(second.systemStable).toBe(first.systemStable)
  })
})

describe('session-start rule injection (FR-INJ-2)', () => {
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

  it('injects the formatted rule block into systemStable, not preamble', async () => {
    const rule = makeRule({ id: 'rule-broad-active', advice: 'SESSION_START_ADVICE_CANARY' })

    const compiled = await assembleSessionContext(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
      [],
      [rule],
    )

    expect(compiled.systemStable).toContain('SESSION_START_ADVICE_CANARY')
    expect(compiled.systemStable).toContain('rule-broad-active')
    expect(compiled.preamble).not.toContain('SESSION_START_ADVICE_CANARY')
  })

  it('emits no active_rules source when every rule is ineligible', async () => {
    const rules = [
      makeRule({ id: 'rule-candidate', status: 'candidate' }),
      makeRule({ id: 'rule-global', scope: 'global' }),
      makeRule({
        id: 'rule-fine',
        triggers: {
          tools: ['Bash'],
          command_prefix: [],
          error_signatures: ["bun-test|TypeError|src/buggy.ts|evaluating 'x'"],
        },
      }),
    ]

    const sources = await buildSessionContextSources(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
      [],
      rules,
    )

    expect(sources.map((source) => source.id)).not.toContain('active_rules')
  })

  it('injects nothing when OCTONOESIS_DISABLE_MEMORY is truthy', async () => {
    const rule = makeRule({ id: 'rule-broad-active', advice: 'DISABLED_MEMORY_CANARY' })
    const original = process.env.OCTONOESIS_DISABLE_MEMORY
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    try {
      const sources = await buildSessionContextSources(
        { repoRoot },
        'test-model',
        { input_tokens: 0, output_tokens: 0 },
        [],
        [],
        [rule],
      )
      expect(sources.map((source) => source.id)).not.toContain('active_rules')
      expect(sources.every((source) => !source.content.includes('DISABLED_MEMORY_CANARY'))).toBe(
        true,
      )
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'OCTONOESIS_DISABLE_MEMORY')
      } else {
        process.env.OCTONOESIS_DISABLE_MEMORY = original
      }
    }
  })

  it('produces byte-identical systemStable across two assemblies with identical rule inputs', async () => {
    const rulesA = [makeRule({ id: 'rule-a' }), makeRule({ id: 'rule-b' })]
    const rulesB = [makeRule({ id: 'rule-a' }), makeRule({ id: 'rule-b' })]

    const first = await assembleSessionContext(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
      [],
      rulesA,
    )
    const second = await assembleSessionContext(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
      [],
      rulesB,
    )

    expect(second.systemStable).toBe(first.systemStable)
  })
})
