import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import {
  appendEpisodes,
  getNextEpisodeIndex,
  readEpisodes,
} from '../../../../src/memory/episodes/store'
import type { Episode } from '../../../../src/memory/episodes/types'

describe('Episode Storage Store Module', () => {
  const tempDir = join(os.tmpdir(), `octonoesis-store-test-${Date.now()}`)
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

  const mockEpisode: Episode = {
    id: 'ep_0001',
    timestamp: '2026-06-20T10:00:00Z',
    session_id: 'sess-123',
    task_digest: 'digest-123',
    failure: {
      tool: 'Bash',
      cmd: 'bun test',
      error_class: 'TypeError',
      signature: 'bash|TypeError|src/buggy.ts',
    },
    fix_candidates: [
      {
        tool: 'Edit',
        path: 'src/buggy.ts',
        summary: 'added check',
        role: 'direct',
      },
    ],
    attribution: {
      status: 'single_direct',
      primary: 'src/buggy.ts',
      confidence: 0.9,
    },
    outcome: 'resolved',
    journal_line_range: { start: 1, end: 10 },
    value_score: 1.0,
    is_excluded: false,
    exclusion_reason: null,
  }

  it('should return empty list when no episodes file exists', async () => {
    const list = await readEpisodes()
    expect(list.length).toBe(0)

    const nextIndex = await getNextEpisodeIndex()
    expect(nextIndex).toBe(1)
  })

  it('should persist and read episodes sequentially', async () => {
    await appendEpisodes([mockEpisode])

    const list = await readEpisodes()
    expect(list.length).toBe(1)
    expect(list[0]?.id).toBe('ep_0001')

    const nextIndex = await getNextEpisodeIndex()
    expect(nextIndex).toBe(2)

    const secondEpisode = { ...mockEpisode, id: 'ep_0002' }
    await appendEpisodes([secondEpisode])

    const updatedList = await readEpisodes()
    expect(updatedList.length).toBe(2)
    expect(updatedList[1]?.id).toBe('ep_0002')

    const updatedNextIndex = await getNextEpisodeIndex()
    expect(updatedNextIndex).toBe(3)
  })

  it('should deduplicate episodes by ID when reading, returning the latest one', async () => {
    const ep1: Episode = { ...mockEpisode, id: 'ep_0005', outcome: 'abandoned' }
    const ep2: Episode = { ...mockEpisode, id: 'ep_0005', outcome: 'resolved' }

    await appendEpisodes([ep1, ep2])

    const list = await readEpisodes()
    const match = list.find((ep) => ep.id === 'ep_0005')
    expect(match).toBeDefined()
    expect(match?.outcome).toBe('resolved')
  })
})
