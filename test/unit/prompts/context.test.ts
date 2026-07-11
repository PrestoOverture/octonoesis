import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { MemoryFile } from '../../../src/memory/auto/types'
import { DEFAULT_CONTEXT_BUDGET } from '../../../src/prompts/compiler'
import { assembleSessionContext, buildSessionContextSources } from '../../../src/prompts/context'

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let tempDir = ''
let repoRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-context-'))
  repoRoot = path.join(tempDir, 'repo')
  memoryDir = path.join(tempDir, 'state')
  await fs.mkdir(repoRoot, { recursive: true })
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
  if (originalMemoryDir === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  } else {
    process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  }
})

function recalledMemory(): MemoryFile {
  return {
    name: 'preferred-test-style',
    description: 'How tests should be written',
    type: 'user',
    content: 'Prefer observable behavior over implementation details.',
    path: path.join(memoryDir, 'memory', 'preferred-test-style.md'),
    mtime: 1,
  }
}

describe('session context assembly', () => {
  it('builds the exact source ids, channels, and priorities', async () => {
    await fs.writeFile(path.join(repoRoot, 'CLAUDE.md'), 'FOLLOW_PROJECT_CANARY', 'utf8')
    await fs.mkdir(path.join(memoryDir, 'memory'), { recursive: true })
    await fs.writeFile(
      path.join(memoryDir, 'memory', 'MEMORY.md'),
      '- [preferred-test-style](preferred-test-style.md) — How tests should be written',
      'utf8',
    )

    const sources = await buildSessionContextSources(
      { repoRoot },
      'test-model',
      { input_tokens: 3, output_tokens: 2 },
      [recalledMemory()],
    )

    expect(sources.map(({ id, channel, priority }) => ({ id, channel, priority }))).toEqual([
      { id: 'static_prompt', channel: 'systemStable', priority: 'critical' },
      { id: 'claude_md', channel: 'systemStable', priority: 'high' },
      { id: 'memory_index', channel: 'systemStable', priority: 'high' },
      { id: 'relevant_memories', channel: 'preamble', priority: 'medium' },
      { id: 'dynamic_suffix', channel: 'preamble', priority: 'low' },
    ])
    expect(sources[1]?.content.startsWith('## Project Instructions (CLAUDE.md)\n')).toBe(true)
    expect(sources[1]?.content).toContain('FOLLOW_PROJECT_CANARY')
    expect(sources[2]?.content).toContain('[preferred-test-style](preferred-test-style.md)')
    expect(sources[3]?.content).toContain('preferred-test-style (user)')
    expect(sources[3]?.content).toContain('Prefer observable behavior')
  })

  it('omits absent CLAUDE.md, memory, and recall sources', async () => {
    const sources = await buildSessionContextSources(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
    )

    expect(sources.map((source) => source.id)).toEqual(['static_prompt', 'dynamic_suffix'])
  })

  it('reports and truncates an oversized CLAUDE.md through its source budget', async () => {
    const cap = DEFAULT_CONTEXT_BUDGET.perSourceCaps.claude_md
    expect(cap).toBeDefined()
    if (cap === undefined) return
    await fs.writeFile(
      path.join(repoRoot, 'CLAUDE.md'),
      `${'x'.repeat(cap * 4 + 100)}TAIL_CANARY`,
      'utf8',
    )

    const compiled = await assembleSessionContext(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [],
    )

    expect(compiled.dropped).toContain('claude_md')
    expect(compiled.systemStable).toContain('## Project Instructions (CLAUDE.md)')
    expect(compiled.systemStable).not.toContain('TAIL_CANARY')
  })

  it('produces byte-identical stable system text for identical inputs', async () => {
    await fs.writeFile(path.join(repoRoot, 'CLAUDE.md'), 'STABLE_CLAUDE_CANARY', 'utf8')
    await fs.mkdir(path.join(memoryDir, 'memory'), { recursive: true })
    await fs.writeFile(path.join(memoryDir, 'memory', 'MEMORY.md'), 'STABLE_INDEX_CANARY', 'utf8')

    const first = await assembleSessionContext(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [recalledMemory()],
    )
    const second = await assembleSessionContext(
      { repoRoot },
      'test-model',
      { input_tokens: 0, output_tokens: 0 },
      [recalledMemory()],
    )

    expect(second.systemStable).toBe(first.systemStable)
  })
})
