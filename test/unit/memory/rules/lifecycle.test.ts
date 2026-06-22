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
    alpha: 3,
    beta: 2,
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

  it('should NOT promote candidate to active when evidence count is too low (e.g. 1 resolved, lower bound not > 0.3)', async () => {
    const candidateRule: RuleFile = {
      ...baseRule,
      evidence: ['ep_0001'],
      alpha: 3,
      beta: 2,
    }

    const result = await updateLifecycle(candidateRule, repoRoot)
    expect(result.status).toBe('candidate')
  })

  it('should promote candidate to active when evidence count is high enough (e.g. 5 resolved, lower bound > 0.3)', async () => {
    const candidateRule: RuleFile = {
      ...baseRule,
      evidence: ['ep_0001', 'ep_0002', 'ep_0003', 'ep_0004', 'ep_0005'],
      alpha: 7, // 2 + 5 hits
      beta: 2,
    }

    const result = await updateLifecycle(candidateRule, repoRoot)
    expect(result.status).toBe('active')
    expect(result.confidence).toBeCloseTo(7 / 9, 4)
  })

  it('should promote candidate to active when user_confirmed is true', async () => {
    const candidateRule: RuleFile = {
      ...baseRule,
      user_confirmed: true,
    }

    const result = await updateLifecycle(candidateRule, repoRoot)
    expect(result.status).toBe('active')
  })

  it('should demote active to retired if 95% CI upper bound drops below 0.45', async () => {
    const activeRule: RuleFile = {
      ...baseRule,
      status: 'active',
      hits: 0,
      misses: 10,
      alpha: 2,
      beta: 12,
      evidence: ['ep_0001'],
    }

    const result = await updateLifecycle(activeRule, repoRoot)
    expect(result.status).toBe('retired')
    expect(result.confidence).toBeCloseTo(2 / 14, 4)
  })

  it('should retire rules if the anchor file is missing', async () => {
    const missingAnchorRule: RuleFile = {
      ...baseRule,
      alpha: 7,
      beta: 2,
      status: 'active',
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
      alpha: 2,
      beta: 12,
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
      alpha: 7,
      beta: 2,
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
      alpha: 7,
      beta: 2,
      created_at: oldDate,
      last_matched_at: recentDate,
    }

    const result = await updateLifecycle(activeRule, repoRoot)
    expect(result.status).toBe('active') // remains active because last matched was 5 days ago
  })
})
