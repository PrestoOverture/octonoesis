import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { appendEpisodes } from '../../../../src/memory/episodes/store.ts'
import type { Episode } from '../../../../src/memory/episodes/types.ts'
import { rebuildRules } from '../../../../src/memory/rules/rebuild.ts'
import { getRulesDir, loadAllRules } from '../../../../src/memory/rules/store.ts'
import { setProvider } from '../../../../src/providers/index.ts'
import type { LLMProvider } from '../../../../src/providers/types.ts'

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
      process.env.OCTONOESIS_MEMORY_DIR = undefined
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
    })

    const allRules = await loadAllRules(rulesDir)
    expect(allRules.length).toBe(1)
    expect(allRules[0]?.id).toBe('rule-package-json-bug')
    expect(allRules[0]?.evidence).toEqual(['ep_0001', 'ep_0002', 'ep_0003', 'ep_0004', 'ep_0005'])
    // Since there are 5 pieces of evidence, it should promote from candidate to active
    expect(allRules[0]?.status).toBe('active')
  })
})
