import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path, { join } from 'node:path'
import { assembleFingerprint } from '../../../src/memory/fingerprint/extract.ts'
import { DISTILL_PROMPT_TEMPLATE } from '../../../src/memory/rules/distill.ts'
import { findMatchingRules } from '../../../src/memory/rules/match.ts'
import type { RuleFile } from '../../../src/memory/rules/types.ts'
import { setProvider } from '../../../src/providers/index.ts'
import type { CanonicalMessage, LLMProvider } from '../../../src/providers/types.ts'
import { assertInsideRepo } from '../../../src/utils/path.ts'
import {
  type SeedRuleFile,
  loadSeedRule,
  parseArgs,
  parseFixResponse,
  runPair,
  runSession,
  saveSeedRule,
  seedTypesFor,
  setupEnv,
} from '../../demo/live-ab.ts'
import { ALL_FIXTURES, type FixtureDef } from '../../fixtures/learning-demo/fixtures.ts'

// A stable substring unique to DISTILL_PROMPT_TEMPLATE (the same one the generalization-requirement
// test in test/unit/memory/rules/distill.test.ts asserts on). Used below to detect whether a
// provider prompt is a distillation call, so we can prove seeded/transfer mode never distills.
// Guarded against the real template at import time so this detector fails loudly (rather than
// silently going vacuous) if that phrase is ever reworded in distill.ts.
const DISTILL_MARKER =
  'Your advice must help with a FUTURE occurrence of this error class, not just restate this one instance.'
if (!DISTILL_PROMPT_TEMPLATE.includes(DISTILL_MARKER)) {
  throw new Error(
    'DISTILL_MARKER is no longer a substring of DISTILL_PROMPT_TEMPLATE — update it in ' +
      'test/unit/demo/live-ab.test.ts to keep the seeded-mode distillation detector meaningful.',
  )
}

/** Extracts the user-message text from a provider call, handling both the solver's plain-string
 *  content and the distiller's [{type:'text', text}] content shape. */
function firstUserText(messages: CanonicalMessage[]): string {
  const first = messages[0]
  const content = first?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textPart = content.find(
      (part): part is { type: 'text'; text: string } => part.type === 'text',
    )
    return textPart?.text ?? ''
  }
  return ''
}

// RepoQuirk fixtures always supply testContent explicitly (buildTestFile()'s generators only
// cover the 5 legacy scenario types), so the default here mirrors real RepoQuirk fixture
// authoring rather than relying on buildTestFile()'s handle-export convention.
function baseFixture(overrides: Partial<FixtureDef> = {}): FixtureDef {
  return {
    id: 'Test_Fixture',
    scenarioType: 'RepoQuirk',
    errorClass: 'ImportError',
    file: 'src/thing.ts',
    expression: 'test expression',
    sourceContent: 'export const value = 1\n',
    stderrOutput: 'ImportError: test\n(fail) test\n',
    extractorResponse: {
      tool: 'bun-test',
      error_class: 'ImportError',
      file: 'src/thing.ts',
      expression: 'test expression',
    },
    fix: { old: 'value = 1', new: 'value = 2' },
    passingOutput: 'pass\n',
    testContent: "import { it } from 'bun:test'\nit('noop', () => {})\n",
    ...overrides,
  }
}

describe('live-ab setupEnv', () => {
  it('materializes extraFiles alongside fixture.file', async () => {
    const fixture = baseFixture({
      extraFiles: {
        'config/settings.json': '{"schema_version":2}',
        'src/lib/helper.ts': 'export const helper = 1\n',
      },
    })

    const { repoRoot } = await setupEnv(fixture, 'unit-extrafiles')
    try {
      const settings = await readFile(join(repoRoot, 'config/settings.json'), 'utf8')
      expect(settings).toBe('{"schema_version":2}')

      const helper = await readFile(join(repoRoot, 'src/lib/helper.ts'), 'utf8')
      expect(helper).toBe('export const helper = 1\n')

      // fixture.file itself must still be materialized as before.
      const source = await readFile(join(repoRoot, fixture.file), 'utf8')
      expect(source).toBe(fixture.sourceContent)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('replaces the default package.json entirely when extraFiles provides one', async () => {
    const customPackageJson = JSON.stringify({
      name: 'custom-repo',
      imports: { '#lib/*': './src/lib/*' },
    })
    const fixture = baseFixture({
      extraFiles: { 'package.json': customPackageJson },
    })

    const { repoRoot } = await setupEnv(fixture, 'unit-pkgjson-override')
    try {
      const pkg = await readFile(join(repoRoot, 'package.json'), 'utf8')
      expect(pkg).toBe(customPackageJson)
      expect(pkg).toContain('#lib/*')
      // Confirm the default-generated package.json (name: octonoesis-live-ab) was not written
      // first and then left in place — the override must be exclusive.
      expect(pkg).not.toContain('octonoesis-live-ab')
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('still writes the default package.json when no override is provided', async () => {
    const fixture = baseFixture()
    const { repoRoot } = await setupEnv(fixture, 'unit-pkgjson-default')
    try {
      const pkg = await readFile(join(repoRoot, 'package.json'), 'utf8')
      expect(pkg).toContain('octonoesis-live-ab')
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('uses testContent verbatim instead of buildTestFile() when provided', async () => {
    const customTest = "import { it } from 'bun:test'\nit('noop', () => {})\n"
    const fixture = baseFixture({ testContent: customTest })
    const { repoRoot, testFile } = await setupEnv(fixture, 'unit-testcontent')
    try {
      const written = await readFile(join(repoRoot, testFile), 'utf8')
      expect(written).toBe(customTest)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('live-ab parseFixResponse', () => {
  it('accepts an edit targeting fixture.fixFile when set, not fixture.file', () => {
    const fixture = baseFixture({
      file: 'src/thing.ts',
      fixFile: 'config/settings.json',
      extraFiles: { 'config/settings.json': '{"schema_version":1}' },
      fix: { old: '"schema_version":1', new: '"schema_version":2' },
    })

    const response = parseFixResponse(
      JSON.stringify({
        file: 'config/settings.json',
        old: '"schema_version":1',
        new: '"schema_version":2',
      }),
      fixture.sourceContent,
      fixture,
    )

    expect(response).not.toBe(null)
    expect(response?.kind).toBe('edit')
    if (response?.kind === 'edit') {
      expect(response.edit.file).toBe('config/settings.json')
    }
  })

  it('rejects an edit targeting fixture.file when fixFile is set to a different path', () => {
    const fixture = baseFixture({
      file: 'src/thing.ts',
      fixFile: 'config/settings.json',
      extraFiles: { 'config/settings.json': '{"schema_version":1}' },
    })

    const response = parseFixResponse(
      JSON.stringify({ file: 'src/thing.ts', old: 'value = 1', new: 'value = 2' }),
      fixture.sourceContent,
      fixture,
    )

    expect(response).toBe(null)
  })

  it('accepts an edit targeting fixture.file when fixFile is unset (legacy behavior)', () => {
    const fixture = baseFixture()

    const response = parseFixResponse(
      JSON.stringify({ file: 'src/thing.ts', old: 'value = 1', new: 'value = 2' }),
      fixture.sourceContent,
      fixture,
    )

    expect(response).not.toBe(null)
    expect(response?.kind).toBe('edit')
    if (response?.kind === 'edit') {
      expect(response.edit.file).toBe('src/thing.ts')
      expect(response.edit.old).toBe('value = 1')
    }
  })

  it('parses a read-action response', () => {
    const fixture = baseFixture()
    const response = parseFixResponse(
      JSON.stringify({ action: 'read', file: 'package.json' }),
      fixture.sourceContent,
      fixture,
    )

    expect(response).toEqual({ kind: 'read', file: 'package.json' })
  })

  it('returns null for malformed JSON', () => {
    const fixture = baseFixture()
    const response = parseFixResponse('not json at all', fixture.sourceContent, fixture)
    expect(response).toBe(null)
  })
})

describe('live-ab read-action path guard (reuses assertInsideRepo)', () => {
  it('rejects a read request for a path outside the repo root', async () => {
    const fixture = baseFixture()
    const { repoRoot } = await setupEnv(fixture, 'unit-readguard')
    try {
      const guard = await assertInsideRepo('../../etc/passwd', repoRoot)
      expect(guard.ok).toBe(false)
      if (!guard.ok) {
        expect(guard.error).toContain('path_outside_repo')
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('rejects an absolute path escaping the repo root', async () => {
    const fixture = baseFixture()
    const { repoRoot } = await setupEnv(fixture, 'unit-readguard-abs')
    try {
      const guard = await assertInsideRepo('/etc/passwd', repoRoot)
      expect(guard.ok).toBe(false)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('accepts a path inside the repo root and does not leak content on rejection', async () => {
    const fixture = baseFixture()
    const { repoRoot } = await setupEnv(fixture, 'unit-readguard-ok')
    try {
      const guard = await assertInsideRepo(fixture.file, repoRoot)
      expect(guard.ok).toBe(true)
      if (guard.ok) {
        const fileStat = await stat(guard.realPath)
        expect(fileStat.isFile()).toBe(true)
      }

      const rejected = await assertInsideRepo('../outside.txt', repoRoot)
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) {
        // The error is a diagnostic string, never file content.
        expect(rejected.error).not.toContain(fixture.sourceContent)
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('live-ab runSession fixFile old-value validation', () => {
  afterEach(() => {
    setProvider(null)
  })

  // Modeled on the RepoQuirk_SettingsVersion fixture in test/fixtures/learning-demo/fixtures.ts:
  // src/thing.ts reads config/settings.json at runtime and throws unless schema_version === 2,
  // so `bun test` genuinely fails until config/settings.json is edited (the fixture's real fix
  // target is fixFile, not file).
  function settingsVersionFixture(): FixtureDef {
    return baseFixture({
      file: 'src/thing.ts',
      fixFile: 'config/settings.json',
      sourceContent:
        "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n\nexport function handleThing(): string {\n  const raw = readFileSync(join(import.meta.dir, '..', 'config', 'settings.json'), 'utf8')\n  const parsed = JSON.parse(raw) as { schema_version: number }\n  if (parsed.schema_version !== 2) {\n    throw new Error(`ConfigError: expected schema_version 2, got ${parsed.schema_version}`)\n  }\n  return 'ok'\n}\n",
      extraFiles: {
        'config/settings.json': JSON.stringify({ schema_version: 1 }, null, 2),
      },
      fix: { old: '"schema_version": 1', new: '"schema_version": 2' },
      testContent:
        "import { describe, it } from 'bun:test'\nimport * as mod from './thing'\n\ndescribe('fixFile old-value validation', () => {\n  it('validates settings schema version', () => {\n    mod.handleThing()\n  })\n})\n",
    })
  }

  function mockProviderWithText(text: string): LLMProvider {
    return {
      name: 'anthropic',
      createMessageStream: async function* () {
        yield { type: 'text_delta', text }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
  }

  it('rejects a fixFile edit whose old value is not present in the real target file, ending the session as a failure', async () => {
    const fixture = settingsVersionFixture()

    // Syntactically valid edit response (file matches fixFile), but `old` does not appear
    // anywhere in config/settings.json's actual content ('{"schema_version": 1}').
    setProvider(
      mockProviderWithText(
        JSON.stringify({
          file: 'config/settings.json',
          old: '"schema_version": 999',
          new: '"schema_version": 2',
        }),
      ),
    )

    const { repoRoot, testFile } = await setupEnv(fixture, 'unit-fixfile-wrongold')
    try {
      const result = await runSession(repoRoot, testFile, fixture, null, 'mock-model')

      expect(result.success).toBe(false)
      expect(result.successfulEdit).toBeUndefined()

      // The rejected response must not have been written to disk: config/settings.json should
      // remain exactly as setupEnv() wrote it (schema_version still 1), proving this was treated
      // as a rejected response rather than a silent no-op write via String.replace().
      const settingsContent = await readFile(join(repoRoot, 'config/settings.json'), 'utf8')
      expect(settingsContent).toBe(JSON.stringify({ schema_version: 1 }, null, 2))

      // Matches the severity of the existing `if (!parsed)` rejection: no turnLog entry gets
      // pushed for a rejected response, since the session returns before reaching the
      // read/edit turnLog.push() calls.
      expect(result.turnLog).toEqual([])
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('accepts a fixFile edit whose old value IS present in the real target file (control case)', async () => {
    const fixture = settingsVersionFixture()

    setProvider(
      mockProviderWithText(
        JSON.stringify({
          file: 'config/settings.json',
          old: '"schema_version": 1',
          new: '"schema_version": 2',
        }),
      ),
    )

    const { repoRoot, testFile } = await setupEnv(fixture, 'unit-fixfile-correctold')
    try {
      const result = await runSession(repoRoot, testFile, fixture, null, 'mock-model')

      expect(result.success).toBe(true)
      expect(result.successfulEdit).toEqual({
        file: 'config/settings.json',
        old: '"schema_version": 1',
        new: '"schema_version": 2',
      })

      const settingsContent = await readFile(join(repoRoot, 'config/settings.json'), 'utf8')
      expect(settingsContent).toContain('"schema_version": 2')
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('live-ab seed-rule save/load keying (Experiment 2 file bank)', () => {
  function sampleRule(id: string, signatures: string[]): RuleFile {
    return {
      id,
      triggers: { tools: ['Bash'], command_prefix: ['bun test'], error_signatures: signatures },
      scope: 'repo',
      alpha: 3,
      beta: 2,
      confidence: 0.6,
      evidence: ['ep_seed'],
      hits: 0,
      misses: 0,
      challenged_by: [],
      anchor: { file: 'src/thing.ts' },
      status: 'candidate',
      user_confirmed: false,
      extractor_version: '0.3.0',
      model_id: 'mock-model',
      prompt_hash: 'deadbeef',
      created_at: '2026-07-04T00:00:00.000Z',
      last_matched_at: null,
      last_rebuilt_at: null,
      advice: `advice for ${id}`,
    }
  }

  it('round-trips a SeedRuleFile keyed by scenario type, without cross-type collision', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octonoesis-seedrule-'))
    try {
      const parseErrorSeed: SeedRuleFile = {
        scenarioType: 'ParseError',
        seedFixtureId: 'ParseError_A1',
        rule: sampleRule('rule-parse', ['bun-test|SyntaxError']),
      }
      const nullAccessSeed: SeedRuleFile = {
        scenarioType: 'NullAccess',
        seedFixtureId: 'NullAccess_A1',
        rule: sampleRule('rule-null', ['bun-test|TypeError']),
      }

      await saveSeedRule(dir, parseErrorSeed)
      await saveSeedRule(dir, nullAccessSeed)

      // File name must match the scenario type (the keying the transfer phase relies on).
      const parseRaw = await readFile(path.join(dir, 'ParseError.json'), 'utf8')
      expect(JSON.parse(parseRaw)).toEqual(parseErrorSeed)

      const loadedParse = await loadSeedRule(dir, 'ParseError')
      const loadedNull = await loadSeedRule(dir, 'NullAccess')
      expect(loadedParse).toEqual(parseErrorSeed)
      expect(loadedNull).toEqual(nullAccessSeed)
      // No collision: each type resolves to its own distinct rule.
      expect(loadedParse?.rule.id).toBe('rule-parse')
      expect(loadedNull?.rule.id).toBe('rule-null')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a scenario type with no seed file (ENOENT)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'octonoesis-seedrule-missing-'))
    try {
      expect(await loadSeedRule(dir, 'ExpectMismatch')).toBe(null)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('live-ab seeded transfer mode skips distillation', () => {
  afterEach(() => {
    setProvider(null)
  })

  // Genuinely fails until config/settings.json is edited (schema_version 1 -> 2), so control can
  // succeed with a single deterministic edit — which is exactly the condition under which normal
  // mode WOULD distill. Mirrors settingsVersionFixture() used earlier in this file.
  function settingsVersionFixture(): FixtureDef {
    return baseFixture({
      file: 'src/thing.ts',
      fixFile: 'config/settings.json',
      errorClass: 'ConfigError',
      expression: 'schema_version mismatch',
      extractorResponse: {
        tool: 'bun-test',
        error_class: 'ConfigError',
        file: 'src/thing.ts',
        expression: 'schema_version mismatch',
      },
      sourceContent:
        "import { readFileSync } from 'node:fs'\nimport { join } from 'node:path'\n\nexport function handleThing(): string {\n  const raw = readFileSync(join(import.meta.dir, '..', 'config', 'settings.json'), 'utf8')\n  const parsed = JSON.parse(raw) as { schema_version: number }\n  if (parsed.schema_version !== 2) {\n    throw new Error(`ConfigError: expected schema_version 2, got ${parsed.schema_version}`)\n  }\n  return 'ok'\n}\n",
      extraFiles: {
        'config/settings.json': JSON.stringify({ schema_version: 1 }, null, 2),
      },
      fix: { old: '"schema_version": 1', new: '"schema_version": 2' },
      testContent:
        "import { describe, it } from 'bun:test'\nimport * as mod from './thing'\n\ndescribe('transfer-mode fixture', () => {\n  it('validates settings schema version', () => {\n    mod.handleThing()\n  })\n})\n",
    })
  }

  const solverEditText = JSON.stringify({
    file: 'config/settings.json',
    old: '"schema_version": 1',
    new: '"schema_version": 2',
  })

  const distillResponseJson = JSON.stringify({
    slug: 'settings-schema',
    triggers: {
      tools: ['Bash'],
      command_prefix: ['bun test'],
      error_signatures: ['bun-test|ConfigError|src/thing.ts|schema_version mismatch'],
    },
    anchor_file: 'config/settings.json',
    advice: 'Ensure config/settings.json declares the schema_version this repo expects.',
  })

  /** Provider that throws if it ever receives a distillation prompt, and otherwise returns a valid
   *  solver fix-edit. Any distillation call proves the seeded path did NOT skip distillation. */
  function providerThatBansDistillation(): LLMProvider {
    return {
      name: 'anthropic',
      createMessageStream: async function* (messages) {
        if (firstUserText(messages).includes(DISTILL_MARKER)) {
          throw new Error('distillation prompt reached the provider in seeded transfer mode')
        }
        yield { type: 'text_delta', text: solverEditText }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
  }

  it('runPair with a non-null seedRule completes without any distillation call', async () => {
    const fixture = settingsVersionFixture()
    setProvider(providerThatBansDistillation())

    const seedFingerprint = assembleFingerprint(
      fixture.extractorResponse.tool,
      fixture.extractorResponse.error_class,
      fixture.extractorResponse.file,
      fixture.extractorResponse.expression,
    )
    const seedRule: RuleFile = {
      id: 'rule-seed',
      triggers: {
        tools: ['Bash'],
        command_prefix: ['bun test'],
        error_signatures: [seedFingerprint.fine, seedFingerprint.medium, seedFingerprint.coarse],
      },
      scope: 'repo',
      alpha: 3,
      beta: 2,
      confidence: 0.6,
      evidence: ['ep_seed'],
      hits: 0,
      misses: 0,
      challenged_by: [],
      anchor: { file: 'config/settings.json' },
      status: 'candidate',
      user_confirmed: false,
      extractor_version: '0.3.0',
      model_id: 'strong-model',
      prompt_hash: 'deadbeef',
      created_at: '2026-07-04T00:00:00.000Z',
      last_matched_at: null,
      last_rebuilt_at: null,
      advice: 'Seed advice: check the repo config schema version.',
    }

    // Must not throw — proves no distillation call happened despite control succeeding.
    const result = await runPair('RepoQuirk', 0, fixture, 'mock-model', 'mock-model', seedRule)

    expect(result.control.success).toBe(true)
    expect(result.treatment.success).toBe(true)
    // Seed rule matched this fixture (its own fingerprint), so a rule was available for treatment,
    // but evidence was NOT gathered from this pair (it reused a pre-seeded rule).
    expect(result.ruleUsed).toBe(true)
    expect(result.evidenceUsed).toBe(null)
    expect(result.matchLevel).toBe('fine')
    expect(result.treatmentAdvice).not.toBe(null)
  })

  it('runPair with seedRule null (normal mode) DOES issue a distillation call (detector sanity)', async () => {
    const fixture = settingsVersionFixture()
    let distillCalled = false
    setProvider({
      name: 'anthropic',
      createMessageStream: async function* (messages) {
        if (firstUserText(messages).includes(DISTILL_MARKER)) {
          distillCalled = true
          yield { type: 'text_delta', text: distillResponseJson }
          yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
          return
        }
        yield { type: 'text_delta', text: solverEditText }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })

    const result = await runPair('RepoQuirk', 0, fixture, 'mock-model', 'mock-model', null)

    expect(result.control.success).toBe(true)
    // The distinctive distillation prompt reached the provider in normal mode — confirms the
    // detector in the sibling test is not vacuously passing.
    expect(distillCalled).toBe(true)
    expect(result.ruleUsed).toBe(true)
    expect(result.evidenceUsed).not.toBe(null)
    expect(result.matchLevel).toBe('fine')
  })
})

describe('live-ab cross-instance match level (core Experiment 2 claim)', () => {
  it('a rule seeded from ParseError_A1 matches a different ParseError fixture at coarse level', () => {
    const seed = ALL_FIXTURES.find((f) => f.id === 'ParseError_A1')
    const other = ALL_FIXTURES.find((f) => f.id === 'ParseError_B1')
    if (!seed || !other) throw new Error('expected ParseError_A1 and ParseError_B1 in ALL_FIXTURES')

    // Sanity: same scenario type, but different file/expression — so they share only the coarse
    // (tool + error_class) fingerprint, never medium or fine.
    expect(seed.scenarioType).toBe(other.scenarioType)
    expect(seed.extractorResponse.file).not.toBe(other.extractorResponse.file)

    const seedFp = assembleFingerprint(
      seed.extractorResponse.tool,
      seed.extractorResponse.error_class,
      seed.extractorResponse.file,
      seed.extractorResponse.expression,
    )
    // Build the rule's signatures the way distill.ts's expandSignatures() would: fine + its
    // medium and coarse prefixes.
    const rule: RuleFile = {
      id: 'rule-parseerror-a1',
      triggers: {
        tools: ['Bash'],
        command_prefix: ['bun test'],
        error_signatures: [seedFp.fine, seedFp.medium, seedFp.coarse],
      },
      scope: 'repo',
      alpha: 3,
      beta: 2,
      confidence: 0.6,
      evidence: ['ep_ParseError_A1'],
      hits: 0,
      misses: 0,
      challenged_by: [],
      anchor: { file: seed.fixFile ?? seed.file },
      status: 'candidate',
      user_confirmed: false,
      extractor_version: '0.3.0',
      model_id: 'strong-model',
      prompt_hash: 'deadbeef',
      created_at: '2026-07-04T00:00:00.000Z',
      last_matched_at: null,
      last_rebuilt_at: null,
      advice: 'When a SyntaxError points at an unbalanced brace, check the block boundaries.',
    }

    const otherFp = assembleFingerprint(
      other.extractorResponse.tool,
      other.extractorResponse.error_class,
      other.extractorResponse.file,
      other.extractorResponse.expression,
    )
    const matches = findMatchingRules([otherFp], [rule])

    expect(matches.length).toBe(1)
    expect(matches[0]?.level).toBe('coarse')
  })
})

describe('live-ab parseArgs seed-flag mutual exclusivity', () => {
  it('throws when both --emit-seed-rules and --seed-rules are passed', () => {
    expect(() =>
      parseArgs(['--emit-seed-rules', '/tmp/seeds', '--seed-rules', '/tmp/seeds']),
    ).toThrow(/mutually exclusive/)
  })

  it('accepts either flag alone', () => {
    expect(parseArgs(['--emit-seed-rules', '/tmp/seeds']).emitSeedRules).toBe('/tmp/seeds')
    expect(parseArgs(['--seed-rules', '/tmp/seeds']).seedRules).toBe('/tmp/seeds')
  })
})

describe('live-ab seedTypesFor (Experiment 2 seed-mode --types filtering)', () => {
  it('filters SEED_FIXTURE_IDS down to the requested types, preserving declaration order', () => {
    // All three seed-capable types, in SEED_FIXTURE_IDS's declaration order.
    expect(seedTypesFor(['ParseError', 'ExpectMismatch', 'NullAccess'])).toEqual([
      ['ParseError', 'ParseError_A1'],
      ['ExpectMismatch', 'ExpectMismatch_A1'],
      ['NullAccess', 'NullAccess_A1'],
    ])

    // Omitting ExpectMismatch excludes it, leaving the other two in order.
    expect(seedTypesFor(['ParseError', 'NullAccess'])).toEqual([
      ['ParseError', 'ParseError_A1'],
      ['NullAccess', 'NullAccess_A1'],
    ])

    // A type with no seed fixture yields no entries.
    expect(seedTypesFor(['ModuleNotFound'])).toEqual([])
  })
})
