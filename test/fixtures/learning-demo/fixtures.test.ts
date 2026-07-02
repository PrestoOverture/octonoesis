import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleFingerprint } from '../../../src/memory/fingerprint/extract.ts'
import {
  ALL_FIXTURES,
  COARSE_GROUPS,
  ERROR_CLASSES,
  FIXTURE_SCHEMA,
  SCENARIO_TYPES,
  byErrorClass,
  byFile,
  byScenario,
  materializeRepo,
} from './fixtures.ts'

const REQUIRED_FILES: Record<string, string[]> = {
  NullAccess: ['src/user.ts', 'src/account.ts', 'src/profile.ts', 'src/session.ts', 'src/auth.ts'],
  TypeMismatch: [
    'src/validator.ts',
    'src/schema.ts',
    'src/transform.ts',
    'src/mapper.ts',
    'src/cast.ts',
  ],
  PromiseReject: [
    'src/fetcher.ts',
    'src/api-client.ts',
    'src/queue.ts',
    'src/worker.ts',
    'src/poller.ts',
  ],
  DeprecatedAPI: [
    'src/router.ts',
    'src/middleware.ts',
    'src/legacy.ts',
    'src/compat.ts',
    'src/adapter.ts',
  ],
  ParseError: [
    'src/parser.ts',
    'src/tokenizer.ts',
    'src/compiler.ts',
    'src/template.ts',
    'src/evaluator.ts',
  ],
  JSONMalformed: [
    'src/json-reader.ts',
    'src/payload.ts',
    'src/serializer.ts',
    'src/decoder.ts',
    'src/importer.ts',
  ],
  InvalidRegex: [
    'src/regex-engine.ts',
    'src/pattern.ts',
    'src/search.ts',
    'src/filter.ts',
    'src/matcher.ts',
  ],
  UndefinedRef: [
    'src/scope.ts',
    'src/context.ts',
    'src/resolver.ts',
    'src/binding.ts',
    'src/injector.ts',
  ],
  OutOfBounds: [
    'src/buffer.ts',
    'src/paginator.ts',
    'src/slicer.ts',
    'src/chunker.ts',
    'src/window.ts',
  ],
  ModuleNotFound: [
    'src/loader.ts',
    'src/plugin.ts',
    'src/registry.ts',
    'src/bootstrap.ts',
    'src/init.ts',
  ],
  MissingExport: [
    'src/re-export.ts',
    'src/barrel.ts',
    'src/index-gen.ts',
    'src/facade.ts',
    'src/surface.ts',
  ],
  ExpectMismatch: [
    'src/calc.ts',
    'src/formatter.ts',
    'src/converter.ts',
    'src/aggregator.ts',
    'src/scorer.ts',
  ],
  SnapshotDrift: [
    'src/button.tsx',
    'src/card.tsx',
    'src/modal.tsx',
    'src/tooltip.tsx',
    'src/badge.tsx',
  ],
  MissingEnvVar: [
    'src/db-config.ts',
    'src/cache-config.ts',
    'src/mail-config.ts',
    'src/storage-config.ts',
    'src/queue-config.ts',
  ],
  ConfigInvalid: [
    'src/app-config.ts',
    'src/server-config.ts',
    'src/log-config.ts',
    'src/auth-config.ts',
    'src/rate-config.ts',
  ],
}

const SUFFIX_FILE_INDEX: Record<string, number> = {
  A1: 0,
  A2: 0,
  A3: 0,
  B1: 1,
  B2: 1,
  B3: 1,
  C1: 2,
  C2: 2,
  D1: 3,
  E1: 4,
}

describe('learning-demo fixtures', () => {
  it('defines the complete scenario and coarse-group catalog', () => {
    // SCENARIO_TYPES now includes 'RepoQuirk' (16 = 15 legacy + 1), but COARSE_GROUPS is
    // deliberately left untouched (7 keys, the original 15 scenario types) — RepoQuirk fixtures
    // intentionally span multiple existing error classes by design (that's what makes the
    // convention undiscoverable a priori), which is incompatible with COARSE_GROUPS' "each
    // scenario type belongs to exactly one coarse bucket" structure. So the "exactly one coarse
    // group" check below iterates only the legacy types (derived from COARSE_GROUPS itself),
    // not raw SCENARIO_TYPES.
    expect(SCENARIO_TYPES.length).toBe(16)
    expect(ERROR_CLASSES.length).toBe(7)
    expect(Object.keys(COARSE_GROUPS).length).toBe(7)

    const legacyScenarioTypes = Object.values(COARSE_GROUPS).flat()
    const scenarioCounts = new Map<string, number>()
    for (const scenarioType of legacyScenarioTypes) {
      scenarioCounts.set(scenarioType, 0)
    }

    for (const scenarioTypes of Object.values(COARSE_GROUPS)) {
      for (const scenarioType of scenarioTypes) {
        scenarioCounts.set(scenarioType, (scenarioCounts.get(scenarioType) ?? 0) + 1)
      }
    }

    for (const scenarioType of legacyScenarioTypes) {
      expect(scenarioCounts.get(scenarioType)).toBe(1)
    }
  })

  it('validates all fixtures and their fingerprint levels', () => {
    // 150 legacy + 3 RepoQuirk (RepoQuirk_Preload was dropped after live testing — see the
    // comment above its former slot in fixtures.ts). This check applies uniformly to RepoQuirk
    // fixtures too — schema validity, fingerprint field consistency, and fine-fingerprint
    // uniqueness are not legacy-only invariants.
    expect(ALL_FIXTURES.length).toBe(153)
    const fineFingerprints = new Set<string>()

    for (const fixture of ALL_FIXTURES) {
      const parsed = FIXTURE_SCHEMA.parse(fixture)
      expect(parsed.id).toBe(fixture.id)
      expect(fixture.extractorResponse.error_class).toBe(fixture.errorClass)
      // Uniform, but the target content differs when fixFile points at a different file than
      // `file` (RepoQuirk only) — mirrors FIXTURE_SCHEMA's superRefine check.
      const fixTargetsOtherFile = fixture.fixFile !== undefined && fixture.fixFile !== fixture.file
      const fixOldContainer = fixTargetsOtherFile
        ? (fixture.extraFiles?.[fixture.fixFile as string] ?? '')
        : fixture.sourceContent
      expect(fixOldContainer.includes(fixture.fix.old)).toBe(true)
      expect(fixture.fix.new === fixture.fix.old).toBe(false)
      expect(fixture.stderrOutput).toContain(`${fixture.errorClass}:`)
      expect(fixture.stderrOutput).toContain(`/tmp/octonoesis-demo/${fixture.file}`)
      expect(fixture.stderrOutput).toContain('(fail)')

      const fingerprint = assembleFingerprint(
        fixture.extractorResponse.tool,
        fixture.extractorResponse.error_class,
        fixture.extractorResponse.file,
        fixture.extractorResponse.expression,
      )

      expect(fingerprint.coarse).toBe(`bun-test|${fixture.errorClass}`)
      expect(fingerprint.medium).toBe(`bun-test|${fixture.errorClass}|${fixture.file}`)
      expect(fingerprint.fine).toBe(
        `bun-test|${fixture.errorClass}|${fixture.file}|${fixture.expression}`,
      )
      expect(fineFingerprints.has(fingerprint.fine)).toBe(false)
      fineFingerprints.add(fingerprint.fine)
    }

    expect(fineFingerprints.size).toBe(153)
  })

  it('provides scenario, error-class, and file lookup helpers', () => {
    expect(byScenario('NullAccess').length).toBe(10)
    expect(byScenario('NullAccess')[0]?.id).toBe('NullAccess_A1')
    // Legacy-only: RepoQuirk fixtures intentionally reuse existing error classes (that's what
    // makes the convention undiscoverable a priori), so byErrorClass(...) results can include
    // RepoQuirk fixtures depending on which error classes they touch. Filter RepoQuirk out
    // rather than adjusting the legacy count, so this stays self-maintaining regardless of
    // which error classes RepoQuirk ends up using (currently ImportError and ConfigError; none
    // of the 3 kept RepoQuirk fixtures use TypeError, but the filter is harmless either way).
    expect(byErrorClass('TypeError').filter((f) => f.scenarioType !== 'RepoQuirk').length).toBe(40)
    expect(byErrorClass('ImportError')[0]?.id).toBe('ModuleNotFound_A1')
    expect(byFile('ParseError', 'src/parser.ts').length).toBe(3)
    expect(byFile('ParseError', 'src/user.ts').length).toBe(0)
  })

  it('preserves 10 fixtures per scenario and correct error-class bucket sizes', () => {
    // Legacy-only: RepoQuirk has 3 fixtures, not 10, and its fixtures don't map onto
    // COARSE_GROUPS at all (see the catalog test above), so both loops here exclude it — the
    // "exactly 10 per type" / "exactly COARSE_GROUPS-derived size per class" invariants are
    // structural properties of the legacy 15-type design, not something RepoQuirk should be
    // forced to satisfy.
    for (const scenarioType of SCENARIO_TYPES) {
      if (scenarioType === 'RepoQuirk') continue
      expect(byScenario(scenarioType).length).toBe(10)
    }

    for (const errorClass of ERROR_CLASSES) {
      const expected = COARSE_GROUPS[errorClass].length * 10
      const actual = byErrorClass(errorClass).filter((f) => f.scenarioType !== 'RepoQuirk').length
      expect(actual).toBe(expected)
    }
  })

  it('uses the required 5-file layout for every scenario', () => {
    // Legacy-only: this assumes every scenario type has exactly 5 files shared across a fixed
    // A1/A2/A3/B1/B2/B3/C1/C2/D1/E1 ID-suffix convention. RepoQuirk fixtures don't follow this
    // convention at all — different files per fixture, non-matching IDs — so RepoQuirk is
    // excluded from this test's iteration entirely rather than shoehorned into REQUIRED_FILES.
    const allFiles = new Set<string>()

    for (const scenarioType of SCENARIO_TYPES) {
      if (scenarioType === 'RepoQuirk') continue
      const scenarioFixtures = byScenario(scenarioType)
      const files = REQUIRED_FILES[scenarioType]
      expect(files).toBeDefined()
      expect(new Set(files).size).toBe(5)

      for (const file of files ?? []) {
        allFiles.add(file)
      }

      for (const fixture of scenarioFixtures) {
        const suffix = fixture.id.split('_')[1] ?? ''
        const fileIndex = SUFFIX_FILE_INDEX[suffix]
        expect(fixture.file).toBe(files?.[fileIndex ?? -1])
      }
    }

    expect(allFiles.size).toBe(75)
  })

  it('preserves coarse, medium, and fine fingerprint sharing invariants', () => {
    const byCoarse = new Map<string, Set<string>>()
    const byScenarioAndFile = new Map<string, string[]>()
    const fineFingerprints = new Set<string>()

    for (const fixture of ALL_FIXTURES) {
      const fingerprint = assembleFingerprint(
        fixture.extractorResponse.tool,
        fixture.extractorResponse.error_class,
        fixture.extractorResponse.file,
        fixture.extractorResponse.expression,
      )

      if (!byCoarse.has(fingerprint.coarse)) {
        byCoarse.set(fingerprint.coarse, new Set())
      }
      byCoarse.get(fingerprint.coarse)?.add(fixture.scenarioType)

      const mediumKey = `${fixture.scenarioType}|${fixture.file}`
      const existing = byScenarioAndFile.get(mediumKey) ?? []
      existing.push(fingerprint.medium)
      byScenarioAndFile.set(mediumKey, existing)

      expect(fineFingerprints.has(fingerprint.fine)).toBe(false)
      fineFingerprints.add(fingerprint.fine)
    }

    // Legacy-only: RepoQuirk fixtures reuse existing error classes on purpose, so the coarse
    // bucket for e.g. TypeError now also contains 'RepoQuirk' alongside the legacy scenario
    // types. Exclude RepoQuirk from the aggregated set before comparing against COARSE_GROUPS,
    // rather than adding it to COARSE_GROUPS (which we deliberately leave untouched).
    for (const errorClass of ERROR_CLASSES) {
      const scenarioTypes = byCoarse.get(`bun-test|${errorClass}`)
      const legacyScenarioTypes = Array.from(scenarioTypes ?? []).filter(
        (scenarioType) => scenarioType !== 'RepoQuirk',
      )
      expect(legacyScenarioTypes.sort()).toEqual([...COARSE_GROUPS[errorClass]].sort())
    }

    // Uniform: each (scenarioType, file) pair sharing exactly one medium fingerprint holds
    // trivially for RepoQuirk too (each RepoQuirk fixture has a distinct file), no exclusion
    // needed.
    for (const mediums of byScenarioAndFile.values()) {
      expect(new Set(mediums).size).toBe(1)
    }

    // Uniform: fine-fingerprint uniqueness is a property of the whole fixture set, RepoQuirk
    // included.
    expect(fineFingerprints.size).toBe(153)
  })

  it('materializes fixture source files and package metadata into a temp repo', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'octonoesis-learning-demo-'))

    try {
      await materializeRepo(tempDir, ALL_FIXTURES)

      const packageStat = await stat(join(tempDir, 'package.json'))
      const tsconfigStat = await stat(join(tempDir, 'tsconfig.json'))
      expect(packageStat.isFile()).toBe(true)
      expect(tsconfigStat.isFile()).toBe(true)

      for (const fixture of ALL_FIXTURES) {
        const fileStat = await stat(join(tempDir, fixture.file))
        expect(fileStat.isFile()).toBe(true)
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

// RepoQuirk-only assertions. These are deliberately separate from the legacy per-type/per-class
// cardinality checks above: RepoQuirk fixtures are exempt from "exactly 10 per scenario type",
// "exactly 1 coarse-group membership", and "exactly 5-file layout" because they intentionally
// span multiple existing error classes and use a bespoke file layout per fixture — that's what
// makes the underlying repo convention undiscoverable a priori (the whole point of the scenario
// family). A future reader should not "fix" those exclusions back; RepoQuirk fixtures are still
// individually held to full FIXTURE_SCHEMA validity and fine-fingerprint uniqueness (verified
// here, and already covered in aggregate by the uniform checks above).
describe('learning-demo fixtures - RepoQuirk', () => {
  it('has 3 RepoQuirk fixtures, each individually schema-valid', () => {
    // Target was 4 (see docs/distiller_fix_plan.md Task 4); RepoQuirk_Preload was dropped after
    // live testing showed it unreliable for control to solve (see the comment in fixtures.ts
    // where it used to sit). 3 meets the plan's stated minimum.
    const repoQuirkFixtures = byScenario('RepoQuirk')
    expect(repoQuirkFixtures.length).toBe(3)

    for (const fixture of repoQuirkFixtures) {
      expect(() => FIXTURE_SCHEMA.parse(fixture)).not.toThrow()
    }
  })

  it('gives every RepoQuirk fixture a unique fine fingerprint', () => {
    const repoQuirkFixtures = byScenario('RepoQuirk')
    const fineFingerprints = new Set<string>()

    for (const fixture of repoQuirkFixtures) {
      const fingerprint = assembleFingerprint(
        fixture.extractorResponse.tool,
        fixture.extractorResponse.error_class,
        fixture.extractorResponse.file,
        fixture.extractorResponse.expression,
      )
      expect(fineFingerprints.has(fingerprint.fine)).toBe(false)
      fineFingerprints.add(fingerprint.fine)
    }

    expect(fineFingerprints.size).toBe(repoQuirkFixtures.length)
  })

  it('has fixFile set only where the fix targets a different file than the error site', () => {
    const repoQuirkFixtures = byScenario('RepoQuirk')
    for (const fixture of repoQuirkFixtures) {
      if (fixture.fixFile !== undefined && fixture.fixFile !== fixture.file) {
        expect(fixture.extraFiles?.[fixture.fixFile]).toBeDefined()
        expect(fixture.extraFiles?.[fixture.fixFile]?.includes(fixture.fix.old)).toBe(true)
      } else {
        expect(fixture.sourceContent.includes(fixture.fix.old)).toBe(true)
      }
    }
  })
})
