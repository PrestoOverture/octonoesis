import { describe, expect, it } from 'bun:test'
import {
  SESSION_START_RULE_LIMIT,
  formatSessionStartRules,
  selectSessionStartRules,
} from '../../../../src/memory/rules/sessionStart.ts'
import type { RuleFile } from '../../../../src/memory/rules/types.ts'

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

describe('SESSION_START_RULE_LIMIT', () => {
  it('is 10', () => {
    expect(SESSION_START_RULE_LIMIT).toBe(10)
  })
})

describe('selectSessionStartRules — status eligibility', () => {
  it('excludes status candidate', () => {
    expect(selectSessionStartRules([makeRule({ id: 'rule-a', status: 'candidate' })])).toEqual([])
  })

  it('excludes status banned', () => {
    expect(selectSessionStartRules([makeRule({ id: 'rule-a', status: 'banned' })])).toEqual([])
  })

  it('excludes status retired', () => {
    expect(selectSessionStartRules([makeRule({ id: 'rule-a', status: 'retired' })])).toEqual([])
  })

  it('excludes status dormant', () => {
    expect(selectSessionStartRules([makeRule({ id: 'rule-a', status: 'dormant' })])).toEqual([])
  })

  it('excludes status superseded', () => {
    expect(selectSessionStartRules([makeRule({ id: 'rule-a', status: 'superseded' })])).toEqual([])
  })

  it('includes status active', () => {
    const rule = makeRule({ id: 'rule-a', status: 'active' })
    expect(selectSessionStartRules([rule])).toEqual([rule])
  })

  it('includes status pinned', () => {
    const rule = makeRule({ id: 'rule-a', status: 'pinned' })
    expect(selectSessionStartRules([rule])).toEqual([rule])
  })
})

describe('selectSessionStartRules — scope eligibility', () => {
  it('excludes scope global', () => {
    const rule = makeRule({ id: 'rule-a', status: 'active', scope: 'global' })
    expect(selectSessionStartRules([rule])).toEqual([])
  })

  it('includes scope repo', () => {
    const rule = makeRule({ id: 'rule-a', status: 'active', scope: 'repo' })
    expect(selectSessionStartRules([rule])).toEqual([rule])
  })
})

describe('selectSessionStartRules — broadness predicate', () => {
  it('excludes a rule whose only error signature is fine (4+ parts)', () => {
    const rule = makeRule({
      id: 'rule-fine',
      triggers: {
        tools: ['Bash'],
        command_prefix: [],
        error_signatures: ["bun-test|TypeError|src/buggy.ts|evaluating 'user.name'"],
      },
    })
    expect(selectSessionStartRules([rule])).toEqual([])
  })

  it('excludes a rule whose only error signature is medium (3 parts)', () => {
    const rule = makeRule({
      id: 'rule-medium',
      triggers: {
        tools: ['Bash'],
        command_prefix: [],
        error_signatures: ['bun-test|TypeError|src/buggy.ts'],
      },
    })
    expect(selectSessionStartRules([rule])).toEqual([])
  })

  it('includes a rule whose error signature is coarse (<=2 parts)', () => {
    const rule = makeRule({
      id: 'rule-coarse',
      triggers: { tools: ['Bash'], command_prefix: [], error_signatures: ['bun-test|TypeError'] },
    })
    expect(selectSessionStartRules([rule])).toEqual([rule])
  })

  it('includes a rule with zero error signatures', () => {
    const rule = makeRule({
      id: 'rule-none',
      triggers: { tools: ['Bash'], command_prefix: [], error_signatures: [] },
    })
    expect(selectSessionStartRules([rule])).toEqual([rule])
  })

  it('excludes a rule mixing a coarse signature with a fine one', () => {
    const rule = makeRule({
      id: 'rule-mixed',
      triggers: {
        tools: ['Bash'],
        command_prefix: [],
        error_signatures: ['bun-test|TypeError', "bun-test|TypeError|src/buggy.ts|evaluating 'x'"],
      },
    })
    expect(selectSessionStartRules([rule])).toEqual([])
  })
})

describe('selectSessionStartRules — cap and ordering', () => {
  it('caps at 10, keeping the highest-confidence rules in descending order', () => {
    const rules = Array.from({ length: 12 }, (_, idx) =>
      makeRule({
        id: `rule-${String(idx).padStart(2, '0')}`,
        // Distinct confidences 0.88, 0.87, ... so ranking is unambiguous.
        confidence: Number((0.88 - idx * 0.01).toFixed(4)),
      }),
    )

    const selected = selectSessionStartRules(rules)

    expect(selected.length).toBe(SESSION_START_RULE_LIMIT)
    expect(selected.map((r) => r.id)).toEqual([
      'rule-00',
      'rule-01',
      'rule-02',
      'rule-03',
      'rule-04',
      'rule-05',
      'rule-06',
      'rule-07',
      'rule-08',
      'rule-09',
    ])
    // Descending confidence.
    for (let i = 1; i < selected.length; i++) {
      const prev = selected[i - 1]
      const cur = selected[i]
      expect(prev).toBeDefined()
      expect(cur).toBeDefined()
      if (prev && cur) expect(prev.confidence >= cur.confidence).toBe(true)
    }
  })

  it('breaks ties at equal confidence by id ascending', () => {
    const rules = [
      makeRule({ id: 'rule-c', confidence: 0.7 }),
      makeRule({ id: 'rule-a', confidence: 0.7 }),
      makeRule({ id: 'rule-b', confidence: 0.7 }),
    ]

    const selected = selectSessionStartRules(rules)

    expect(selected.map((r) => r.id)).toEqual(['rule-a', 'rule-b', 'rule-c'])
  })

  it('returns an empty array for empty input', () => {
    expect(selectSessionStartRules([])).toEqual([])
  })
})

describe('formatSessionStartRules', () => {
  it('returns the empty string for empty input', () => {
    expect(formatSessionStartRules([])).toBe('')
  })

  it('renders a header plus each rule id and advice, framed as learned guidance', () => {
    const rules = [
      makeRule({ id: 'rule-a', advice: 'Prefer optional chaining in src/buggy.ts.' }),
      makeRule({ id: 'rule-b', advice: 'Run bun test before editing fixtures.' }),
    ]

    const formatted = formatSessionStartRules(rules)

    expect(formatted).toContain('rule-a')
    expect(formatted).toContain('Prefer optional chaining in src/buggy.ts.')
    expect(formatted).toContain('rule-b')
    expect(formatted).toContain('Run bun test before editing fixtures.')
    // Honest framing: guidance from past sessions, not a command.
    expect(formatted.toLowerCase()).toContain('this repository')
    expect(formatted.toLowerCase()).toContain('guidance')
    expect(formatted).not.toContain('You must')
  })

  it('produces byte-identical output across two calls with equal-value input', () => {
    const rulesA = [makeRule({ id: 'rule-a' }), makeRule({ id: 'rule-b' })]
    const rulesB = [makeRule({ id: 'rule-a' }), makeRule({ id: 'rule-b' })]

    expect(formatSessionStartRules(rulesA)).toBe(formatSessionStartRules(rulesB))
  })
})
