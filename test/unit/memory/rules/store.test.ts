import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import {
  getRulesDir,
  loadAllRules,
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
      process.env.OCTONOESIS_MEMORY_DIR = undefined
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
