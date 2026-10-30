import { expect, test } from 'bun:test'
import { assembleFingerprint } from '../../../../src/memory/fingerprint/extract'
import { findMatchingRules } from '../../../../src/memory/rules/match'
import { parseRule, serializeRule } from '../../../../src/memory/rules/store'
import type { RuleFile } from '../../../../src/memory/rules/types'

function rule(signature: string): RuleFile {
  return {
    id: 'rule-signature-integrity',
    triggers: { tools: ['Bash'], command_prefix: ['bun test'], error_signatures: [signature] },
    scope: 'repo',
    alpha: 3,
    beta: 2,
    confidence: 0.6,
    evidence: ['ep_synthetic'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: { file: 'src/example.ts' },
    status: 'candidate',
    user_confirmed: false,
    extractor_version: 'test',
    model_id: 'test',
    prompt_hash: 'test',
    created_at: '2026-01-01T00:00:00.000Z',
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: 'Inspect the failing operation.',
  }
}

test('runner spelling is canonical for new fingerprints and legacy rule matching', () => {
  const spaced = assembleFingerprint('bun test', 'TypeError', 'example.test.ts', 'value.run()')
  const dashed = assembleFingerprint('bun-test', 'TypeError', 'example.test.ts', 'value.run()')
  expect(spaced).toEqual(dashed)
  const legacy = rule('bun test|TypeError|example.test.ts|value.run()')
  expect(findMatchingRules([dashed], [legacy]).map((m) => m.rule.id)).toEqual([legacy.id])
  expect(
    findMatchingRules(
      [assembleFingerprint('bun-test', 'TypeError', 'example.test.ts', 'other.run()')],
      [legacy],
    ),
  ).toEqual([])
})

test('multiline signatures round-trip without truncation or injected frontmatter entries', () => {
  const signature =
    'bun-test|TypeError|example.test.ts|expected:\n+ actual\n- "wanted"\nstatus: banned\npath C:\\tmp'
  const source = rule(signature)
  const parsed = parseRule(serializeRule(source))
  expect(parsed.triggers.error_signatures).toEqual([signature])
  expect(parsed.status).toBe('candidate')
  const fp = assembleFingerprint(
    'bun-test',
    'TypeError',
    'example.test.ts',
    signature.split('|')[3] ?? '',
  )
  expect(findMatchingRules([fp], [parsed]).map((m) => m.rule.id)).toEqual([source.id])
})

test('legacy unquoted signatures with quotes and backslashes still load literally', () => {
  const signature = 'bun-test|TypeError|example.test.ts|run("C:\\tmp")'
  const serialized = serializeRule(rule(signature))
  const legacy = serialized.replace(JSON.stringify(signature), signature)
  expect(parseRule(legacy).triggers.error_signatures).toEqual([signature])
})
