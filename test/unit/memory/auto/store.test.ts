import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyMemoryWrites,
  loadMemories,
  loadMemoryIndex,
  parseMemory,
  serializeMemory,
} from '../../../../src/memory/auto/store'
import type { MemoryFile, MemoryWrite } from '../../../../src/memory/auto/types'
import { flushJournal } from '../../../../src/memory/journal'

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let memoryDir = ''

beforeEach(async () => {
  memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-auto-memory-store-'))
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
})

afterEach(async () => {
  await flushJournal()
  await fs.rm(memoryDir, { recursive: true, force: true })
  if (originalMemoryDir === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  } else {
    process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  }
})

function write(overrides: Partial<MemoryWrite> = {}): MemoryWrite {
  return {
    action: 'create',
    name: 'preferred-test-style',
    type: 'user',
    description: 'Use behavior-focused tests',
    content: 'Prefer observable behavior.',
    ...overrides,
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

describe('auto-memory store', () => {
  it('round-trips YAML frontmatter and markdown content', () => {
    const memory: MemoryFile = {
      name: 'preferred-test-style',
      description: 'Use behavior-focused tests: including edge cases',
      type: 'user',
      content: 'Prefer tests that describe **observable behavior**.',
      path: '/tmp/preferred-test-style.md',
      mtime: 123,
    }

    expect(parseMemory(serializeMemory(memory), memory.path, memory.mtime)).toEqual(memory)
  })

  it('regenerates a deterministic index after create, update, and delete', async () => {
    await applyMemoryWrites([
      write({ name: 'zeta', description: 'Zeta description' }),
      write({ name: 'alpha', description: 'Alpha description', type: 'project' }),
    ])

    expect(await loadMemoryIndex()).toBe(
      '- [alpha](alpha.md) — Alpha description\n- [zeta](zeta.md) — Zeta description',
    )

    await applyMemoryWrites([
      write({
        action: 'update',
        name: 'alpha',
        type: 'feedback',
        description: 'Updated alpha',
        content: 'Updated body.',
      }),
      write({ action: 'delete', name: 'zeta' }),
    ])

    const memories = await loadMemories()
    expect(
      memories.map(({ name, description, type, content }) => ({
        name,
        description,
        type,
        content,
      })),
    ).toEqual([
      {
        name: 'alpha',
        description: 'Updated alpha',
        type: 'feedback',
        content: 'Updated body.',
      },
    ])
    expect(await loadMemoryIndex()).toBe('- [alpha](alpha.md) — Updated alpha')
    expect(await fileExists(path.join(memoryDir, 'memory', 'zeta.md'))).toBe(false)
  })

  it('rejects unsafe names before applying any write', async () => {
    for (const name of ['../x', '/tmp/x', 'Uppercase', 'two words']) {
      await expect(applyMemoryWrites([write({ name })])).rejects.toThrow('Invalid memory name')
    }

    await expect(
      applyMemoryWrites([write({ name: 'would-have-been-valid' }), write({ name: '../escape' })]),
    ).rejects.toThrow('Invalid memory name')
    expect(await fileExists(path.join(memoryDir, 'memory', 'would-have-been-valid.md'))).toBe(false)
    expect(await fileExists(path.join(memoryDir, 'memory'))).toBe(false)
  })

  it('tail-truncates MEMORY.md to 200 lines and 25KB at load', async () => {
    const indexPath = path.join(memoryDir, 'memory', 'MEMORY.md')
    await fs.mkdir(path.dirname(indexPath), { recursive: true })
    const lines = Array.from(
      { length: 300 },
      (_, index) => `line-${index.toString().padStart(3, '0')}-${'x'.repeat(200)}`,
    )
    await fs.writeFile(indexPath, lines.join('\n'), 'utf8')

    const loaded = await loadMemoryIndex()

    expect(Buffer.byteLength(loaded) <= 25 * 1024).toBe(true)
    expect(loaded.split('\n').length <= 200).toBe(true)
    expect(loaded).toContain('line-299-')
    expect(loaded).not.toContain('line-000-')
  })

  it('journals one v2 memory_write event for each applied action', async () => {
    await applyMemoryWrites([write({ action: 'create', name: 'one' })])
    await applyMemoryWrites([write({ action: 'update', name: 'one', type: 'feedback' })])
    await applyMemoryWrites([write({ action: 'delete', name: 'one', type: 'project' })])
    await flushJournal()

    const rows = (await fs.readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(
      rows.map(({ kind, name, type, action, schema_version }) => ({
        kind,
        name,
        type,
        action,
        schema_version,
      })),
    ).toEqual([
      {
        kind: 'memory_write',
        name: 'one',
        type: 'user',
        action: 'create',
        schema_version: 2,
      },
      {
        kind: 'memory_write',
        name: 'one',
        type: 'feedback',
        action: 'update',
        schema_version: 2,
      },
      {
        kind: 'memory_write',
        name: 'one',
        type: 'project',
        action: 'delete',
        schema_version: 2,
      },
    ])
  })
})
