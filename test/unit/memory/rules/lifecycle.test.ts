import { describe, expect, it } from 'bun:test'
import { updateLifecycle } from '../../../../src/memory/rules/lifecycle.ts'
import type { RuleFile } from '../../../../src/memory/rules/types.ts'
import { getRepoRoot } from '../../../../src/utils/path.ts'

describe('Rule Lifecycle Transitions', () => {
  const repoRoot = getRepoRoot()

  const baseRule: RuleFile = {
    id: 'rule-test',
    triggers: {
      tools: ['Bash'],
      command_prefix: [],
      error_signatures: ['bash|TypeError|package.json'],
    },
    scope: 'repo',
    confidence: 0.6,
    evidence: ['ep_0001'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'package.json' }, // package.json exists in repo root
    status: 'candidate',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'mock',
    prompt_hash: 'hash',
    created_at: new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'some advice',
  }

  it('should promote candidate to active when evidence count is >= 2', async () => {
    const candidateRule: RuleFile = {
      ...baseRule,
      evidence: ['ep_0001', 'ep_0002'],
    }

    const result = await updateLifecycle(candidateRule, repoRoot)
    expect(result.status).toBe('active')
    // Confidence formula: (hits + 0.5 * evidenceCount + 1) / (hits + misses + 0.5 * evidenceCount + 2)
    // hits=0, misses=0, evidenceCount=2 -> (0 + 1 + 1) / (0 + 0 + 1 + 2) = 2/3 = 0.6667
    expect(result.confidence).toBe(0.6667)
  })

  it('should promote candidate to active when user_confirmed is true', async () => {
    const candidateRule: RuleFile = {
      ...baseRule,
      user_confirmed: true,
    }

    const result = await updateLifecycle(candidateRule, repoRoot)
    expect(result.status).toBe('active')
  })

  it('should demote active to retired if confidence drops below 0.45', async () => {
    const activeRule: RuleFile = {
      ...baseRule,
      status: 'active',
      hits: 0,
      misses: 4, // high miss rate lowers confidence
      evidence: ['ep_0001'],
    }

    const result = await updateLifecycle(activeRule, repoRoot)
    expect(result.status).toBe('retired')
    // hits=0, misses=4, evidenceCount=1 -> (0 + 0.5 + 1) / (0 + 4 + 0.5 + 2) = 1.5 / 6.5 = 0.2308
    expect(result.confidence).toBe(0.2308)
  })

  it('should retire rules if the anchor file is missing', async () => {
    const missingAnchorRule: RuleFile = {
      ...baseRule,
      anchor: { file: 'non-existent-file-xyz.ts' },
    }

    const result = await updateLifecycle(missingAnchorRule, repoRoot)
    expect(result.status).toBe('retired')
  })

  it('should treat pinned and banned states as immune to demotion', async () => {
    const pinnedRule: RuleFile = {
      ...baseRule,
      status: 'pinned',
      anchor: { file: 'non-existent-file-xyz.ts' }, // missing anchor
      hits: 0,
      misses: 10, // extremely low confidence
    }

    const result = await updateLifecycle(pinnedRule, repoRoot)
    expect(result.status).toBe('pinned') // status is preserved

    const bannedRule: RuleFile = {
      ...baseRule,
      status: 'banned',
      anchor: { file: 'non-existent-file-xyz.ts' },
    }

    const result2 = await updateLifecycle(bannedRule, repoRoot)
    expect(result2.status).toBe('banned')
  })

  it('should make active rule dormant if no trigger match has occurred for 90 days', async () => {
    const oldDate = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString()
    const oldRule: RuleFile = {
      ...baseRule,
      status: 'active',
      created_at: oldDate,
    }

    const result = await updateLifecycle(oldRule, repoRoot)
    expect(result.status).toBe('dormant')
  })

  it('should NOT make active rule dormant if matched recently, even if created > 90 days ago', async () => {
    const oldDate = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString()
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    const activeRule: RuleFile = {
      ...baseRule,
      status: 'active',
      created_at: oldDate,
      last_matched_at: recentDate,
    }

    const result = await updateLifecycle(activeRule, repoRoot)
    expect(result.status).toBe('active') // remains active because last matched was 5 days ago
  })
})
