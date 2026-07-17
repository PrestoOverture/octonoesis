import { describe, expect, it } from 'bun:test'
import {
  enforcePoolCap,
  getRuleSpecificity,
  isPoolCapRelevantStatus,
} from '../../../../src/memory/rules/pool.ts'
import type { RuleFile } from '../../../../src/memory/rules/types.ts'

describe('Rule Pool Cap and Eviction', () => {
  const baseRule: Omit<RuleFile, 'id' | 'triggers' | 'created_at' | 'confidence'> = {
    scope: 'repo',
    alpha: 3,
    beta: 2,
    evidence: ['ep_0001'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'package.json' },
    status: 'candidate',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'mock',
    prompt_hash: 'hash',
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'some advice',
  }

  it('should compute specificity correctly based on error signature parts', () => {
    const coarseRule: RuleFile = {
      ...baseRule,
      id: 'rule-coarse',
      confidence: 0.6,
      triggers: {
        tools: ['Bash'],
        command_prefix: [],
        error_signatures: ['bun-test|TypeError'],
      },
      created_at: new Date().toISOString(),
    }
    expect(getRuleSpecificity(coarseRule)).toBe(1)

    const mediumRule: RuleFile = {
      ...baseRule,
      id: 'rule-medium',
      confidence: 0.6,
      triggers: {
        tools: ['Bash'],
        command_prefix: [],
        error_signatures: ['bun-test|TypeError|package.json'],
      },
      created_at: new Date().toISOString(),
    }
    expect(getRuleSpecificity(mediumRule)).toBe(2)

    const fineRule: RuleFile = {
      ...baseRule,
      id: 'rule-fine',
      confidence: 0.6,
      triggers: {
        tools: ['Bash'],
        command_prefix: [],
        error_signatures: ["bun-test|TypeError|package.json|evaluating 'user.name'"],
      },
      created_at: new Date().toISOString(),
    }
    expect(getRuleSpecificity(fineRule)).toBe(3)
  })

  it('should not evict any rule if pool is under the cap (150)', () => {
    const rules: RuleFile[] = Array.from({ length: 140 }, (_, idx) => ({
      ...baseRule,
      id: `rule-${idx}`,
      confidence: 0.6,
      triggers: {
        tools: ['Bash'],
        command_prefix: [],
        error_signatures: ['bun-test|TypeError|package.json'],
      },
      created_at: new Date().toISOString(),
    }))

    const result = enforcePoolCap(rules)
    expect(result.filter((r) => r.status === 'candidate').length).toBe(140)
  })

  it('should evict lowest scored rules when pool exceeds 150', () => {
    // Generate 152 rules
    // We'll make rule-151 coarse, low confidence, and old so it gets lowest score
    // We'll make rule-150 medium, high confidence, and new so it has higher score
    const rules: RuleFile[] = Array.from({ length: 152 }, (_, idx) => {
      const isLowest = idx === 0 || idx === 1
      return {
        ...baseRule,
        id: `rule-${idx}`,
        confidence: isLowest ? 0.1 : 0.8,
        status: 'candidate',
        triggers: {
          tools: ['Bash'],
          command_prefix: [],
          error_signatures: isLowest ? ['coarse-sig'] : ['medium-sig|file.ts|detail'], // coarse vs medium/fine
        },
        // Old vs new
        created_at: isLowest
          ? new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() // 100 days old
          : new Date().toISOString(),
      }
    })

    const result = enforcePoolCap(rules)
    const retired = result.filter((r) => r.status === 'retired')
    const active = result.filter((r) => r.status === 'candidate' || r.status === 'active')

    expect(retired.length).toBe(2)
    expect(active.length).toBe(150)

    // Assert that the two lowest-score rules (rule-0 and rule-1) are retired
    expect(retired.find((r) => r.id === 'rule-0')).toBeDefined()
    expect(retired.find((r) => r.id === 'rule-1')).toBeDefined()
  })

  it('evicts only within the active/candidate subset of a mixed-status >150 pool (post-unification)', () => {
    // 152 active/candidate rules (2 over the cap) plus non-pool-relevant statuses that
    // are deliberately given the lowest possible score (old + coarse + low confidence)
    // so that if isPoolCapRelevantStatus's exclusion were broken -- e.g. reverted to an
    // inline filter that forgot a status -- these would be the ones evicted instead.
    const activeAndCandidate: RuleFile[] = Array.from({ length: 152 }, (_, idx) => {
      const isLowest = idx === 0 || idx === 1
      return {
        ...baseRule,
        id: `rule-relevant-${idx}`,
        confidence: isLowest ? 0.1 : 0.8,
        status: idx % 2 === 0 ? 'active' : 'candidate',
        triggers: {
          tools: ['Bash'],
          command_prefix: [],
          error_signatures: isLowest ? ['coarse-sig'] : ['medium-sig|file.ts|detail'],
        },
        created_at: isLowest
          ? new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
          : new Date().toISOString(),
      }
    })
    const nonRelevant: RuleFile[] = (
      ['pinned', 'banned', 'retired', 'dormant', 'superseded'] as const
    ).map((status, idx) => ({
      ...baseRule,
      id: `rule-non-relevant-${status}`,
      confidence: 0.01,
      status,
      triggers: {
        tools: ['Bash'],
        command_prefix: [],
        error_signatures: ['coarse-sig'],
      },
      created_at: new Date(Date.now() - (200 + idx) * 24 * 60 * 60 * 1000).toISOString(),
    }))

    const result = enforcePoolCap([...activeAndCandidate, ...nonRelevant])

    // Exactly 2 evicted, and only from the active/candidate subset.
    expect(result.filter((r) => isPoolCapRelevantStatus(r.status)).length).toBe(150)
    expect(result.find((r) => r.id === 'rule-relevant-0')?.status).toBe('retired')
    expect(result.find((r) => r.id === 'rule-relevant-1')?.status).toBe('retired')
    // Non-pool-relevant statuses pass through completely unchanged, never chosen for
    // eviction despite scoring lowest of all 157 rules in the pool.
    for (const status of ['pinned', 'banned', 'retired', 'dormant', 'superseded'] as const) {
      expect(result.find((r) => r.id === `rule-non-relevant-${status}`)?.status).toBe(status)
    }
  })
})
