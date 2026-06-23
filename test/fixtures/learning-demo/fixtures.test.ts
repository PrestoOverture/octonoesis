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
    expect(SCENARIO_TYPES.length).toBe(15)
    expect(ERROR_CLASSES.length).toBe(7)
    expect(Object.keys(COARSE_GROUPS).length).toBe(7)

    const scenarioCounts = new Map<string, number>()
    for (const scenarioType of SCENARIO_TYPES) {
      scenarioCounts.set(scenarioType, 0)
    }

    for (const scenarioTypes of Object.values(COARSE_GROUPS)) {
      for (const scenarioType of scenarioTypes) {
        scenarioCounts.set(scenarioType, (scenarioCounts.get(scenarioType) ?? 0) + 1)
      }
    }

    for (const scenarioType of SCENARIO_TYPES) {
      expect(scenarioCounts.get(scenarioType)).toBe(1)
    }
  })

  it('validates all fixtures and their fingerprint levels', () => {
    expect(ALL_FIXTURES.length).toBe(150)
    const fineFingerprints = new Set<string>()

    for (const fixture of ALL_FIXTURES) {
      const parsed = FIXTURE_SCHEMA.parse(fixture)
      expect(parsed.id).toBe(fixture.id)
      expect(fixture.extractorResponse.error_class).toBe(fixture.errorClass)
      expect(fixture.sourceContent.includes(fixture.fix.old)).toBe(true)
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

    expect(fineFingerprints.size).toBe(150)
  })

  it('provides scenario, error-class, and file lookup helpers', () => {
    expect(byScenario('NullAccess').length).toBe(10)
    expect(byScenario('NullAccess')[0]?.id).toBe('NullAccess_A1')
    expect(byErrorClass('TypeError').length).toBe(40)
    expect(byErrorClass('ImportError')[0]?.id).toBe('ModuleNotFound_A1')
    expect(byFile('ParseError', 'src/parser.ts').length).toBe(3)
    expect(byFile('ParseError', 'src/user.ts').length).toBe(0)
  })

  it('preserves 10 fixtures per scenario and correct error-class bucket sizes', () => {
    for (const scenarioType of SCENARIO_TYPES) {
      expect(byScenario(scenarioType).length).toBe(10)
    }

    for (const errorClass of ERROR_CLASSES) {
      const expected = COARSE_GROUPS[errorClass].length * 10
      expect(byErrorClass(errorClass).length).toBe(expected)
    }
  })

  it('uses the required 5-file layout for every scenario', () => {
    const allFiles = new Set<string>()

    for (const scenarioType of SCENARIO_TYPES) {
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

    for (const errorClass of ERROR_CLASSES) {
      const scenarioTypes = byCoarse.get(`bun-test|${errorClass}`)
      expect(Array.from(scenarioTypes ?? []).sort()).toEqual([...COARSE_GROUPS[errorClass]].sort())
    }

    for (const mediums of byScenarioAndFile.values()) {
      expect(new Set(mediums).size).toBe(1)
    }

    expect(fineFingerprints.size).toBe(150)
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
