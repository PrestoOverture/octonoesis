import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import {
  archiveRule,
  getRulesArchiveDir,
  getRulesDir,
  loadAllRules,
  loadAllRulesIncludingArchived,
  loadRule,
  parseRule,
  saveRule,
  serializeRule,
} from '../../../../src/memory/rules/store.ts'
import type { RuleFile } from '../../../../src/memory/rules/types.ts'

describe('Rule Storage Store Module', () => {
  const tempDir = join(os.tmpdir(), `octonoesis-rules-store-test-${Date.now()}`)
  let originalMemoryDir: string | undefined

  beforeAll(async () => {
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    process.env.OCTONOESIS_MEMORY_DIR = tempDir
    await rm(tempDir, { recursive: true, force: true })
    await mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    if (originalMemoryDir === undefined) {
      Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  const mockRule: RuleFile = {
    id: 'rule-optional-chaining-buggy',
    triggers: {
      tools: ['Bash'],
      command_prefix: ['bun test'],
      error_signatures: ['bash|TypeError|src/buggy.ts'],
    },
    scope: 'repo',
    alpha: 3,
    beta: 2,
    confidence: 0.6,
    evidence: ['ep_0001'],
    hits: 0,
    misses: 0,
    challenged_by: [],
    anchor: {
      file: 'src/buggy.ts',
    },
    status: 'candidate',
    user_confirmed: false,
    extractor_version: '0.2.0',
    model_id: 'mock-model',
    prompt_hash: 'a1b2c3d4',
    created_at: '2026-06-20T10:00:00.000Z',
    last_matched_at: null,
    last_rebuilt_at: null,
    advice: '# Advice\n\nAlways use optional chaining.',
  }

  it('should serialize and parse rule round-trip cleanly', () => {
    const serialized = serializeRule(mockRule)
    const parsed = parseRule(serialized)

    expect(parsed.id).toBe(mockRule.id)
    expect(parsed.user_confirmed).toBe(mockRule.user_confirmed)
    expect(parsed.triggers.tools).toEqual(mockRule.triggers.tools)
    expect(parsed.triggers.command_prefix).toEqual(mockRule.triggers.command_prefix)
    expect(parsed.triggers.error_signatures).toEqual(mockRule.triggers.error_signatures)
    expect(parsed.scope).toBe(mockRule.scope)
    expect(parsed.alpha).toBe(mockRule.alpha)
    expect(parsed.beta).toBe(mockRule.beta)
    expect(parsed.confidence).toBe(mockRule.confidence)
    expect(parsed.evidence).toEqual(mockRule.evidence)
    expect(parsed.hits).toBe(mockRule.hits)
    expect(parsed.misses).toBe(mockRule.misses)
    expect(parsed.challenged_by).toEqual(mockRule.challenged_by)
    expect(parsed.anchor.file).toBe(mockRule.anchor.file)
    expect(parsed.status).toBe(mockRule.status)
    expect(parsed.extractor_version).toBe(mockRule.extractor_version)
    expect(parsed.model_id).toBe(mockRule.model_id)
    expect(parsed.prompt_hash).toBe(mockRule.prompt_hash)
    expect(parsed.created_at).toBe(mockRule.created_at)
    expect(parsed.last_matched_at).toBe(mockRule.last_matched_at)
    expect(parsed.last_rebuilt_at).toBe(mockRule.last_rebuilt_at)
    expect(parsed.advice).toBe(mockRule.advice)
  })

  it('should return null when loading non-existent rule', async () => {
    const loaded = await loadRule('rule-non-existent')
    expect(loaded).toBe(null)
  })

  it('should save, load, and list rules from disk', async () => {
    await saveRule(mockRule)

    const loaded = await loadRule(mockRule.id)
    expect(loaded).not.toBe(null)
    expect(loaded?.id).toBe(mockRule.id)

    const allRules = await loadAllRules()
    expect(allRules.length).toBe(1)
    expect(allRules[0]?.id).toBe(mockRule.id)
  })

  it('should throw clear error on missing frontmatter keys', () => {
    const malformedYaml = `---
id: rule-test
triggers:
  tools:
    - Bash
status: candidate
---
Some advice.`
    expect(() => parseRule(malformedYaml)).toThrow('Missing required frontmatter key')
  })

  it('should propagate parsing errors when loading a malformed rule from disk', async () => {
    const rulesDir = getRulesDir()
    const badFilePath = join(rulesDir, 'rule-malformed.md')
    await writeFile(badFilePath, '---\nid: rule-malformed\n---\nAdvice text', 'utf-8')

    expect(loadRule('rule-malformed')).rejects.toThrow('Missing required frontmatter key')
  })

  it('should propagate parsing errors from loadAllRules when there is a malformed rule file', async () => {
    const rulesDir = getRulesDir()
    const badFilePath = join(rulesDir, 'rule-malformed.md')
    await writeFile(badFilePath, '---\nid: rule-malformed\n---\nAdvice text', 'utf-8')

    expect(loadAllRules()).rejects.toThrow('Missing required frontmatter key')
  })
})

describe('Rule Archive Directory', () => {
  // Isolated from the describe above (own temp dir, explicit rulesDir on every call)
  // so this suite is unaffected by that describe's shared, order-dependent fixtures
  // (e.g. the malformed rule file left behind by its final tests).
  const archiveTestDir = join(os.tmpdir(), `octonoesis-rules-archive-test-${Date.now()}`)
  const rulesDir = join(archiveTestDir, 'rules')

  beforeAll(async () => {
    await rm(archiveTestDir, { recursive: true, force: true })
    await mkdir(rulesDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(archiveTestDir, { recursive: true, force: true })
  })

  function makeArchivableRule(id: string, overrides: Partial<RuleFile> = {}): RuleFile {
    return {
      id,
      triggers: {
        tools: ['Bash'],
        command_prefix: ['bun test'],
        error_signatures: ['bash|TypeError|src/archived.ts'],
      },
      scope: 'repo',
      alpha: 2,
      beta: 5,
      confidence: 0.2857,
      evidence: ['ep_archive_0001'],
      hits: 0,
      misses: 3,
      challenged_by: [],
      anchor: { file: 'src/archived.ts' },
      status: 'retired',
      user_confirmed: false,
      extractor_version: '0.2.0',
      model_id: 'mock-model',
      prompt_hash: 'deadbeef',
      created_at: '2026-06-20T10:00:00.000Z',
      last_matched_at: null,
      last_rebuilt_at: null,
      advice: '# Advice\n\nArchived rule advice.',
      ...overrides,
    }
  }

  async function pathExists(path: string): Promise<boolean> {
    return stat(path)
      .then(() => true)
      .catch(() => false)
  }

  it('getRulesArchiveDir resolves to an archive subdirectory of the given rules dir', () => {
    expect(getRulesArchiveDir(rulesDir)).toBe(join(rulesDir, 'archive'))
  })

  it('archiveRule writes the archive copy then removes the hot-dir file', async () => {
    const rule = makeArchivableRule('rule-archive-basic')
    await saveRule(rule, rulesDir)
    const hotPath = join(rulesDir, `${rule.id}.md`)
    expect(await pathExists(hotPath)).toBe(true)

    await archiveRule(rule, rulesDir)

    const archivePath = join(getRulesArchiveDir(rulesDir), `${rule.id}.md`)
    const archived = parseRule(await readFile(archivePath, 'utf-8'))
    expect(archived.id).toBe(rule.id)
    expect(archived.status).toBe('retired')
    expect(await pathExists(hotPath)).toBe(false)
  })

  it('archiveRule succeeds even when no hot-dir copy exists', async () => {
    const rule = makeArchivableRule('rule-archive-no-hot-copy')

    await expect(archiveRule(rule, rulesDir)).resolves.toBeUndefined()

    const archivePath = join(getRulesArchiveDir(rulesDir), `${rule.id}.md`)
    expect((await readFile(archivePath, 'utf-8')).length).toBeGreaterThan(0)
  })

  it('archiveRule overwriting an existing archive entry for the same id is fine', async () => {
    const rule = makeArchivableRule('rule-archive-overwrite', { misses: 3 })
    await archiveRule(rule, rulesDir)

    const updated = { ...rule, misses: 4 }
    await expect(archiveRule(updated, rulesDir)).resolves.toBeUndefined()

    const archivePath = join(getRulesArchiveDir(rulesDir), `${rule.id}.md`)
    expect(parseRule(await readFile(archivePath, 'utf-8')).misses).toBe(4)
  })

  it('loadAllRules ignores rule files that live inside the archive subdirectory', async () => {
    const hotRule = makeArchivableRule('rule-hot-only', { status: 'candidate' })
    await saveRule(hotRule, rulesDir)
    // Same rule-*.md naming convention, but nested one level down in archive/ --
    // a non-recursive hot-dir listing must not pick this up.
    const archivedRule = makeArchivableRule('rule-inside-archive-dir')
    await archiveRule(archivedRule, rulesDir)

    const hotRules = await loadAllRules(rulesDir)
    expect(hotRules.map((rule) => rule.id).sort()).toEqual(['rule-hot-only'])
  })

  it('loadAllRulesIncludingArchived merges hot and archive, hot copy winning on id collision', async () => {
    const dir = join(archiveTestDir, 'merge-test')
    await mkdir(dir, { recursive: true })

    const archiveOnlyRule = makeArchivableRule('rule-archive-only', { status: 'dormant' })
    await archiveRule(archiveOnlyRule, dir)

    // Archive an id, then also save a *different* hot copy under the same id --
    // simulates a rule that was archived and later re-saved hot without cleanup.
    await archiveRule(
      makeArchivableRule('rule-colliding', {
        status: 'superseded',
        advice: 'stale archived advice',
        hits: 1,
      }),
      dir,
    )
    await saveRule(
      makeArchivableRule('rule-colliding', {
        status: 'candidate',
        advice: 'fresh hot advice',
        hits: 99,
      }),
      dir,
    )

    const hotOnlyRule = makeArchivableRule('rule-hot-only-2', { status: 'active' })
    await saveRule(hotOnlyRule, dir)

    const merged = await loadAllRulesIncludingArchived(dir)
    const byId = new Map(merged.map((rule) => [rule.id, rule]))

    expect(merged.length).toBe(3)
    expect(byId.get('rule-archive-only')?.status).toBe('dormant')
    expect(byId.get('rule-hot-only-2')?.status).toBe('active')
    // Hot-wins: the merged entry must be the fresh hot version, not the stale archived one.
    expect(byId.get('rule-colliding')?.status).toBe('candidate')
    expect(byId.get('rule-colliding')?.advice).toBe('fresh hot advice')
    expect(byId.get('rule-colliding')?.hits).toBe(99)
  })

  it('loadAllRules and loadAllRulesIncludingArchived never create the archive directory on a pure read', async () => {
    const dir = join(archiveTestDir, 'no-create-test')
    await mkdir(dir, { recursive: true })
    await saveRule(makeArchivableRule('rule-plain-hot', { status: 'candidate' }), dir)

    await loadAllRules(dir)
    await loadAllRulesIncludingArchived(dir)

    expect(await pathExists(getRulesArchiveDir(dir))).toBe(false)
  })

  it('loadAllRulesIncludingArchived resolves to an empty array when the rules directory is missing, without creating it', async () => {
    const missingParent = join(archiveTestDir, 'does-not-exist')
    const missingRulesDir = join(missingParent, 'rules')

    expect(await loadAllRulesIncludingArchived(missingRulesDir)).toEqual([])

    expect(await pathExists(missingParent)).toBe(false)
  })
})
