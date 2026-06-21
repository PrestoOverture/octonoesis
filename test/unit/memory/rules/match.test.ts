import { describe, expect, it } from 'bun:test'
import { assembleFingerprint } from '../../../../src/memory/fingerprint/extract'
import { findMatchingRules, formatMatchAdvice } from '../../../../src/memory/rules/match'
import type { RuleFile } from '../../../../src/memory/rules/types'

describe('Fingerprint Rule Matcher', () => {
  const fp1 = assembleFingerprint('bun-test', 'TypeError', 'src/buggy.ts', "evaluating 'user.name'")
  const fp2 = assembleFingerprint('bun-test', 'SyntaxError', 'src/parser.ts', 'unexpected token')

  const ruleActiveFine: RuleFile = {
    id: 'rule-active-fine',
    triggers: {
      tools: ['Bash'],
      command_prefix: ['bun test'],
      error_signatures: [fp1.fine],
    },
    scope: 'repo',
    confidence: 0.8,
    evidence: ['ep_0001'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'src/buggy.ts' },
    status: 'active',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'model-id',
    prompt_hash: 'hash',
    created_at: new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'Use optional chaining on buggy.ts line 12.',
  }

  const ruleCandidateMedium: RuleFile = {
    id: 'rule-candidate-medium',
    triggers: {
      tools: ['Bash'],
      command_prefix: ['bun test'],
      error_signatures: [fp1.medium],
    },
    scope: 'repo',
    confidence: 0.6,
    evidence: ['ep_0002'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'src/buggy.ts' },
    status: 'candidate',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'model-id',
    prompt_hash: 'hash',
    created_at: new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'Ensure buggy.ts is not null.',
  }

  const ruleRetiredCoarse: RuleFile = {
    id: 'rule-retired-coarse',
    triggers: {
      tools: ['Bash'],
      command_prefix: ['bun test'],
      error_signatures: [fp1.coarse],
    },
    scope: 'repo',
    confidence: 0.3,
    evidence: ['ep_0003'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'src/buggy.ts' },
    status: 'retired',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'model-id',
    prompt_hash: 'hash',
    created_at: new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'Retired advice.',
  }

  const ruleActiveCoarse: RuleFile = {
    id: 'rule-active-coarse',
    triggers: {
      tools: ['Bash'],
      command_prefix: ['bun test'],
      error_signatures: [fp1.coarse],
    },
    scope: 'repo',
    confidence: 0.7,
    evidence: ['ep_0004'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'src/buggy.ts' },
    status: 'active',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'model-id',
    prompt_hash: 'hash',
    created_at: new Date().toISOString(),
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'General TypeError advice.',
  }

  it('should only match active or candidate rules', () => {
    const rules = [ruleActiveFine, ruleCandidateMedium, ruleRetiredCoarse]
    const matches = findMatchingRules([fp1], rules)
    expect(matches.length).toBe(2)
    expect(matches[0]?.rule.id).toBe('rule-active-fine')
    expect(matches[1]?.rule.id).toBe('rule-candidate-medium')
  })

  it('should prioritize matches fine -> medium -> coarse', () => {
    // If coarse matches exist, but a fine match exists, fine matches should come first
    const rules = [ruleActiveCoarse, ruleActiveFine, ruleCandidateMedium]
    const matches = findMatchingRules([fp1], rules)
    expect(matches.length).toBe(2)
    expect(matches[0]?.rule.id).toBe('rule-active-fine')
    expect(matches[0]?.level).toBe('fine')
    expect(matches[1]?.rule.id).toBe('rule-candidate-medium')
    expect(matches[1]?.level).toBe('medium')
  })

  it('should respect the 2-rule budget and not duplicate matches', () => {
    const rules = [ruleActiveFine, ruleCandidateMedium, ruleActiveCoarse]
    const matches = findMatchingRules([fp1, fp1], rules) // duplicate fingerprints input
    expect(matches.length).toBe(2)
    expect(matchedRuleIds(matches)).toContain('rule-active-fine')
    expect(matchedRuleIds(matches)).toContain('rule-candidate-medium')
  })

  it('should apply low-confidence framing only to coarse matches', () => {
    const matchFine = { rule: ruleActiveFine, fingerprint: fp1, level: 'fine' as const }
    const matchCoarse = { rule: ruleActiveCoarse, fingerprint: fp1, level: 'coarse' as const }

    const adviceFine = formatMatchAdvice(matchFine)
    expect(adviceFine).toContain('matched your current error signature')
    expect(adviceFine).not.toContain('Low-confidence advice fallback')

    const adviceCoarse = formatMatchAdvice(matchCoarse)
    expect(adviceCoarse).toContain('Low-confidence advice fallback')
    expect(adviceCoarse).toContain('sometimes seen this class of error')
  })
})

function matchedRuleIds(matches: ReturnType<typeof findMatchingRules>): string[] {
  return matches.map((m) => m.rule.id)
}
