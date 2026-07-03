import { afterEach, describe, expect, it } from 'bun:test'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setProvider } from '../../../src/providers/index.ts'
import type { LLMProvider } from '../../../src/providers/types.ts'
import { assertInsideRepo } from '../../../src/utils/path.ts'
import { parseFixResponse, runSession, setupEnv } from '../../demo/live-ab.ts'
import type { FixtureDef } from '../../fixtures/learning-demo/fixtures.ts'

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
