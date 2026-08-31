import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { appendEpisodes } from '../../../../src/memory/episodes/store.ts'
import type { Episode } from '../../../../src/memory/episodes/types.ts'
import { rebuildRules } from '../../../../src/memory/rules/rebuild.ts'
import {
  archiveRule,
  getRulesArchiveDir,
  getRulesDir,
  loadAllRules,
} from '../../../../src/memory/rules/store.ts'
import type { RuleFile } from '../../../../src/memory/rules/types.ts'
import { setProvider } from '../../../../src/providers/index.ts'
import type { CanonicalMessage, LLMProvider } from '../../../../src/providers/types.ts'
import { restoreEnv } from '../../../helpers/env.ts'

describe('Rebuild rules capability', () => {
  const tempDir = join(os.tmpdir(), `octonoesis-rebuild-rules-test-${Date.now()}`)
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

  afterEach(() => {
    setProvider(null)
  })

  const mockEpisode1: Episode = {
    id: 'ep_0001',
    timestamp: '2026-06-20T10:00:00Z',
    session_id: 'sess-123',
    task_digest: 'task 1',
    failure: {
      tool: 'Bash',
      cmd: 'bun test',
      error_class: 'TypeError',
      signature: 'bash|TypeError|package.json',
    },
    fix_candidates: [
      {
        tool: 'Edit',
        path: 'package.json',
        summary: 'updated version',
        role: 'direct',
      },
    ],
    attribution: {
      status: 'single_direct',
      primary: 'package.json',
      confidence: 0.9,
    },
    outcome: 'resolved',
    journal_line_range: { start: 1, end: 10 },
    value_score: 1.0,
    is_excluded: false,
    exclusion_reason: null,
  }

  const mockEpisode2: Episode = {
    ...mockEpisode1,
    id: 'ep_0002',
    timestamp: '2026-06-20T10:10:00Z',
  }

  const mockEpisode3: Episode = {
    ...mockEpisode1,
    id: 'ep_0003',
    timestamp: '2026-06-20T10:20:00Z',
  }

  const mockEpisode4: Episode = {
    ...mockEpisode1,
    id: 'ep_0004',
    timestamp: '2026-06-20T10:30:00Z',
  }

  const mockEpisode5: Episode = {
    ...mockEpisode1,
    id: 'ep_0005',
    timestamp: '2026-06-20T10:40:00Z',
  }

  it('should distill and rebuild rules from multiple episodes cleanly', async () => {
    await appendEpisodes([mockEpisode1, mockEpisode2, mockEpisode3, mockEpisode4, mockEpisode5])

    const mockJson = {
      slug: 'package-json-bug',
      triggers: {
        tools: ['Bash'],
        command_prefix: ['bun test'],
        error_signatures: ['bash|TypeError|package.json'],
      },
      anchor_file: 'package.json',
      advice: 'Ensure package.json is correct.',
    }

    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* () {
        yield { type: 'text_delta', text: JSON.stringify(mockJson) }
      },
    }

    setProvider(mockProvider)

    const rulesDir = getRulesDir()
    await rebuildRules(join(tempDir, 'episodes.jsonl'), rulesDir, {
      model: 'mock-model',
      extractorVersion: '0.2.0',
      forceDistill: true,
      repoRoot: process.cwd(),
    })

    const allRules = await loadAllRules(rulesDir)
    expect(allRules.length).toBe(1)
    expect(allRules[0]?.id).toBe('rule-package-json-bug')
    expect(allRules[0]?.evidence).toEqual(['ep_0001', 'ep_0002', 'ep_0003', 'ep_0004', 'ep_0005'])
    // Since there are 5 pieces of evidence, it should promote from candidate to active
    expect(allRules[0]?.status).toBe('active')
  })

  it('routes terminal-status output to archive/ and non-terminal to the hot dir; pre-existing archive files survive a rebuild', async () => {
    const scenarioDir = join(os.tmpdir(), `octonoesis-rebuild-archive-test-${Date.now()}`)
    const repoRoot = join(scenarioDir, 'repo')
    const memoryDir = join(scenarioDir, 'memory')
    const rulesDir = join(memoryDir, 'rules')
    const episodesPath = join(memoryDir, 'episodes.jsonl')
    const priorMemoryDir = process.env.OCTONOESIS_MEMORY_DIR

    function promptText(messages: CanonicalMessage[]): string {
      const content = messages[0]?.content
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content.find((block) => block.type === 'text')?.text ?? ''
    }

    function archiveTestEpisode(id: string, file: string, timestamp: string): Episode {
      return {
        id,
        timestamp,
        session_id: 'sess-archive-test',
        task_digest: `fix ${file}`,
        failure: {
          tool: 'Bash',
          cmd: 'bun test',
          error_class: 'TypeError',
          signature: `bash|TypeError|${file}`,
        },
        fix_candidates: [{ tool: 'Edit', path: file, summary: 'fixed', role: 'direct' }],
        attribution: { status: 'single_direct', primary: file, confidence: 0.9 },
        outcome: 'resolved',
        journal_line_range: { start: 1, end: 1 },
        value_score: 1,
        is_excluded: false,
        exclusion_reason: null,
      }
    }

    try {
      await mkdir(join(repoRoot, 'src'), { recursive: true })
      await mkdir(rulesDir, { recursive: true })
      // Anchor exists for the "present" episode; deliberately absent for "missing" --
      // updateLifecycle force-retires any non-pinned/banned rule whose anchor is gone.
      await writeFile(join(repoRoot, 'src/present.ts'), 'export {}\n')

      // A pre-existing archived rule whose signature will NOT reappear in this
      // rebuild's episodes: it must survive completely untouched (never pulled back
      // into rebuiltRules, never rewritten, never deleted).
      const survivorRule: RuleFile = {
        id: 'rule-pre-existing-archived',
        triggers: {
          tools: ['Bash'],
          command_prefix: ['bun test'],
          error_signatures: ['bash|TypeError|src/unrelated.ts'],
        },
        scope: 'repo',
        alpha: 2,
        beta: 6,
        confidence: 0.25,
        evidence: ['ep_old'],
        hits: 0,
        misses: 4,
        challenged_by: [],
        anchor: { file: 'src/unrelated.ts' },
        status: 'dormant',
        user_confirmed: false,
        extractor_version: '0.2.0',
        model_id: 'mock-model',
        prompt_hash: 'aaaaaaaa',
        created_at: '2026-01-01T00:00:00.000Z',
        last_matched_at: null,
        last_rebuilt_at: null,
        advice: 'Old archived advice that must survive byte-for-byte.',
      }
      await archiveRule(survivorRule, rulesDir)
      const survivorArchivePath = join(getRulesArchiveDir(rulesDir), `${survivorRule.id}.md`)
      const survivorContentBefore = await readFile(survivorArchivePath, 'utf-8')

      process.env.OCTONOESIS_MEMORY_DIR = memoryDir
      await appendEpisodes([
        archiveTestEpisode('ep_archive_present', 'src/present.ts', '2026-06-21T10:00:00Z'),
        archiveTestEpisode('ep_archive_missing', 'src/missing.ts', '2026-06-21T10:10:00Z'),
      ])

      setProvider({
        name: 'anthropic',
        createMessageStream: async function* (messages) {
          const prompt = promptText(messages)
          const signature = prompt.match(/^- Error signature: (.+)$/m)?.[1] ?? 'bash|Error'
          const anchor = prompt.match(/^- File: (.+?) \(Role:/m)?.[1] ?? ''
          const slug = anchor.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'archived'
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              slug,
              triggers: {
                tools: ['Bash'],
                command_prefix: ['bun test'],
                error_signatures: [signature],
              },
              anchor_file: anchor,
              advice: `Resolve ${signature}.`,
            }),
          }
        },
      })

      await rebuildRules(episodesPath, rulesDir, {
        model: 'mock-model',
        extractorVersion: '0.2.0',
        forceDistill: true,
        repoRoot,
      })

      const hotRules = await loadAllRules(rulesDir)
      const archivedRules = await loadAllRules(getRulesArchiveDir(rulesDir))

      const presentSig = 'bash|TypeError|src/present.ts'
      const missingSig = 'bash|TypeError|src/missing.ts'

      // Non-terminal (anchor present) rule lands in the hot dir, not the archive.
      const presentRule = hotRules.find((rule) =>
        rule.triggers.error_signatures.includes(presentSig),
      )
      expect(presentRule).toBeDefined()
      expect(presentRule?.status).not.toBe('retired')
      expect(
        archivedRules.some((rule) => rule.triggers.error_signatures.includes(presentSig)),
      ).toBe(false)

      // Terminal (anchor missing) rule lands in the archive, not the hot dir.
      const missingRule = archivedRules.find((rule) =>
        rule.triggers.error_signatures.includes(missingSig),
      )
      expect(missingRule).toBeDefined()
      expect(missingRule?.status).toBe('retired')
      expect(hotRules.some((rule) => rule.triggers.error_signatures.includes(missingSig))).toBe(
        false,
      )

      // Pre-existing archive file, irrelevant to this rebuild's episodes, survives untouched.
      expect(await readFile(survivorArchivePath, 'utf-8')).toBe(survivorContentBefore)
      expect(hotRules.some((rule) => rule.id === 'rule-pre-existing-archived')).toBe(false)
    } finally {
      restoreEnv('OCTONOESIS_MEMORY_DIR', priorMemoryDir)
      await rm(scenarioDir, { recursive: true, force: true })
    }
  })
})
