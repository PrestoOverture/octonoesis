import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assignArm,
  filterRulesForArm,
  recordAssignment,
} from '../../../src/experiments/assignment.ts'
import type { ExperimentRecord } from '../../../src/experiments/schema.ts'
import type { RuleFile } from '../../../src/memory/rules/types.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempMemoryDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-experiments-assignment-'))
  tempDirs.push(dir)
  return dir
}

function experiment(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    schema_version: 1,
    id: 'exp-assignment-test',
    registered_at: '2026-07-17T00:00:00.000Z',
    hypothesis: 'H',
    endpoints: { primary: 'p', secondary: [] },
    test: { method: 'm', pass_line: 'x' },
    arms: [
      { name: 'A', prompt_hashes: ['hash-a'] },
      { name: 'B', prompt_hashes: ['hash-b'] },
    ],
    status: 'running',
    ...overrides,
  }
}

function rule(overrides: Partial<RuleFile> & { id: string; prompt_hash: string }): RuleFile {
  return {
    triggers: { tools: ['Bash'], command_prefix: [], error_signatures: ['bun-test|TypeError'] },
    scope: 'repo',
    alpha: 3,
    beta: 2,
    confidence: 0.6,
    evidence: [],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'package.json' },
    status: 'active',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'mock',
    created_at: '2026-07-01T00:00:00.000Z',
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: `advice for ${overrides.id}`,
    ...overrides,
  }
}

describe('assignArm', () => {
  it('is deterministic: repeated calls with the same inputs return the same arm', () => {
    const exp = experiment()
    const first = assignArm('session-fixed', exp)
    for (let i = 0; i < 10; i++) {
      expect(assignArm('session-fixed', exp)).toBe(first)
    }
  })

  it('reaches both arms across a set of 32 distinct session ids', () => {
    const exp = experiment()
    const seen = new Set<string>()
    for (let i = 0; i < 32; i++) {
      seen.add(assignArm(`session-${i}`, exp))
    }
    expect(seen).toEqual(new Set(['A', 'B']))
  })

  it('is a pure function of (sessionId, experiment.id, arm names/order) - independent of unrelated fields', () => {
    const exp1 = experiment({ hypothesis: 'one hypothesis' })
    const exp2 = experiment({ hypothesis: 'a totally different hypothesis' })
    expect(assignArm('session-x', exp1)).toBe(assignArm('session-x', exp2))
  })

  it('throws when the experiment has no arms', () => {
    const noArms = experiment()
    // biome-ignore lint/performance/noDelete: constructing a no-arms fixture
    delete (noArms as { arms?: unknown }).arms
    expect(() => assignArm('session-x', noArms)).toThrow()
  })
})

describe('filterRulesForArm', () => {
  const exp = experiment()
  const rules = [
    rule({ id: 'rule-a', prompt_hash: 'hash-a' }),
    rule({ id: 'rule-b', prompt_hash: 'hash-b' }),
    rule({ id: 'rule-unclaimed', prompt_hash: 'hash-unclaimed' }),
  ]

  it('keeps an unclaimed rule regardless of which arm is asking', () => {
    const forA = filterRulesForArm(rules, exp, 'A')
    const forB = filterRulesForArm(rules, exp, 'B')
    expect(forA.some((r) => r.id === 'rule-unclaimed')).toBe(true)
    expect(forB.some((r) => r.id === 'rule-unclaimed')).toBe(true)
  })

  it('keeps a rule claimed by the asking arm and excludes rules claimed by other arms', () => {
    const forA = filterRulesForArm(rules, exp, 'A')
    expect(forA.map((r) => r.id).sort()).toEqual(['rule-a', 'rule-unclaimed'])

    const forB = filterRulesForArm(rules, exp, 'B')
    expect(forB.map((r) => r.id).sort()).toEqual(['rule-b', 'rule-unclaimed'])
  })

  it('does not mutate the input array', () => {
    const before = [...rules]
    filterRulesForArm(rules, exp, 'A')
    expect(rules).toEqual(before)
    expect(rules.length).toBe(3)
  })

  it('returns all rules unfiltered when the experiment declares no arms', () => {
    const noArms = experiment()
    // biome-ignore lint/performance/noDelete: constructing a no-arms fixture
    delete (noArms as { arms?: unknown }).arms
    const result = filterRulesForArm(rules, noArms, 'anything')
    expect(result.map((r) => r.id).sort()).toEqual(['rule-a', 'rule-b', 'rule-unclaimed'])
  })

  it('A/A property: two arms claiming identical prompt_hashes yield identical filtered pools', () => {
    const aa = experiment({
      arms: [
        { name: 'X', prompt_hashes: ['hash-a', 'hash-b'] },
        { name: 'Y', prompt_hashes: ['hash-a', 'hash-b'] },
      ],
    })
    const forX = filterRulesForArm(rules, aa, 'X')
    const forY = filterRulesForArm(rules, aa, 'Y')
    expect(forX.map((r) => r.id)).toEqual(forY.map((r) => r.id))
    expect(forX.map((r) => r.id).sort()).toEqual(['rule-a', 'rule-b', 'rule-unclaimed'])
  })
})

describe('recordAssignment', () => {
  it('appends one schema_version-1 line with the given session/experiment/arm', async () => {
    const dir = await tempMemoryDir()
    await recordAssignment({ session_id: 's1', experiment_id: 'exp-x', arm: 'A' }, dir)

    const content = await fs.readFile(path.join(dir, 'experiment-assignments.jsonl'), 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0] ?? '{}')
    expect(parsed.schema_version).toBe(1)
    expect(parsed.session_id).toBe('s1')
    expect(parsed.experiment_id).toBe('exp-x')
    expect(parsed.arm).toBe('A')
    expect(typeof parsed.ts).toBe('string')
    expect(Number.isNaN(new Date(parsed.ts).getTime())).toBe(false)
  })

  it('creates the memory dir and file on first write, and appends further lines after', async () => {
    const dir = await tempMemoryDir()
    const target = path.join(dir, 'nested', 'memdir')
    await recordAssignment({ session_id: 's1', experiment_id: 'exp-x', arm: 'A' }, target)
    await recordAssignment({ session_id: 's2', experiment_id: 'exp-x', arm: 'B' }, target)

    const content = await fs.readFile(path.join(target, 'experiment-assignments.jsonl'), 'utf8')
    expect(content.trim().split('\n').length).toBe(2)
  })
})
