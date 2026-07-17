import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  appendExperimentRecord,
  getActiveExperiment,
  readExperiments,
} from '../../../src/experiments/registry.ts'
import type { ExperimentRecord } from '../../../src/experiments/schema.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempMemoryDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-experiments-registry-'))
  tempDirs.push(dir)
  return dir
}

function record(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    schema_version: 1,
    id: 'exp-registry-test',
    registered_at: '2026-07-17T00:00:00.000Z',
    hypothesis: 'H',
    endpoints: { primary: 'p', secondary: [] },
    test: { method: 'm', pass_line: 'x' },
    arms: [
      { name: 'A', prompt_hashes: ['hash-a'] },
      { name: 'B', prompt_hashes: ['hash-b'] },
    ],
    status: 'registered',
    ...overrides,
  }
}

describe('readExperiments', () => {
  it('returns [] and creates nothing when the registry file is missing', async () => {
    const dir = await tempMemoryDir()
    const target = path.join(dir, 'does-not-exist')

    expect(await readExperiments(target)).toEqual([])

    let exists = true
    try {
      await fs.stat(target)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  it('skips malformed JSON lines and schema-invalid records without failing the read', async () => {
    const dir = await tempMemoryDir()
    await fs.mkdir(dir, { recursive: true })
    const good = record()
    const lines = [
      JSON.stringify(good),
      'this is not json at all {{{',
      JSON.stringify({ schema_version: 1, id: 'exp-missing-fields', status: 'registered' }),
      '',
    ]
    await fs.writeFile(path.join(dir, 'experiments.jsonl'), `${lines.join('\n')}\n`)

    const result = await readExperiments(dir)
    expect(result).toEqual([good])
  })

  it('dedupes by id with the last line winning, preserving first-seen position', async () => {
    const dir = await tempMemoryDir()
    await fs.mkdir(dir, { recursive: true })
    const first = record({ id: 'exp-a', status: 'registered' })
    const other = record({
      id: 'exp-b',
      arms: [
        { name: 'A', prompt_hashes: ['hb-a'] },
        { name: 'B', prompt_hashes: ['hb-b'] },
      ],
    })
    const amended = { ...first, status: 'running' as const }
    const lines = [first, other, amended].map((entry) => JSON.stringify(entry))
    await fs.writeFile(path.join(dir, 'experiments.jsonl'), `${lines.join('\n')}\n`)

    const result = await readExperiments(dir)
    expect(result.map((entry) => entry.id)).toEqual(['exp-a', 'exp-b'])
    expect(result[0]?.status).toBe('running')
  })
})

describe('appendExperimentRecord', () => {
  it('round-trips a freshly-registered record and creates the memory dir/file on first append', async () => {
    const dir = await tempMemoryDir()
    const target = path.join(dir, 'nested', 'memdir')
    const input = record()

    const saved = await appendExperimentRecord(input, target)
    expect(saved).toEqual(input)

    const readBack = await readExperiments(target)
    expect(readBack).toEqual([input])

    const stat = await fs.stat(path.join(target, 'experiments.jsonl'))
    expect(stat.isFile()).toBe(true)
  })

  it('rejects a schema-invalid record and appends nothing', async () => {
    const dir = await tempMemoryDir()
    await expect(appendExperimentRecord(record({ hypothesis: '' }), dir)).rejects.toThrow(
      /Invalid experiment record/,
    )
    expect(await readExperiments(dir)).toEqual([])
  })

  it('allows a monotonic status transition (registered -> running) with unchanged preregistered fields', async () => {
    const dir = await tempMemoryDir()
    const original = record({ status: 'registered' })
    await appendExperimentRecord(original, dir)

    const running = { ...original, status: 'running' as const }
    const saved = await appendExperimentRecord(running, dir)
    expect(saved.status).toBe('running')
    expect((await readExperiments(dir))[0]?.status).toBe('running')
  })

  it('allows an equal-status amendment to result/decision/concluded_at on a concluded record', async () => {
    const dir = await tempMemoryDir()
    const original = record({ status: 'running' })
    await appendExperimentRecord(original, dir)
    const concluded = {
      ...original,
      status: 'concluded' as const,
      result: 'first result',
      decision: 'ship A',
      concluded_at: '2026-08-01T00:00:00.000Z',
    }
    await appendExperimentRecord(concluded, dir)

    const amended = { ...concluded, result: 'amended result' }
    const saved = await appendExperimentRecord(amended, dir)
    expect(saved.result).toBe('amended result')
    expect((await readExperiments(dir))[0]?.result).toBe('amended result')
  })

  it('throws on a backwards status transition (concluded -> running)', async () => {
    const dir = await tempMemoryDir()
    const original = record({ status: 'running' })
    await appendExperimentRecord(original, dir)
    const concluded = {
      ...original,
      status: 'concluded' as const,
      result: 'r',
      decision: 'd',
      concluded_at: '2026-08-01T00:00:00.000Z',
    }
    await appendExperimentRecord(concluded, dir)

    await expect(appendExperimentRecord({ ...original, status: 'running' }, dir)).rejects.toThrow(
      /backwards/,
    )
    // Nothing was appended by the rejected write.
    expect((await readExperiments(dir))[0]?.status).toBe('concluded')
  })

  it('throws when a preregistered field (hypothesis) changes on a same-id amendment', async () => {
    const dir = await tempMemoryDir()
    const original = record({ status: 'registered' })
    await appendExperimentRecord(original, dir)

    await expect(
      appendExperimentRecord({ ...original, hypothesis: 'a different hypothesis' }, dir),
    ).rejects.toThrow(/immutable/)
    expect((await readExperiments(dir))[0]?.hypothesis).toBe(original.hypothesis)
  })

  it('throws when a preregistered field (arms) changes on a same-id amendment', async () => {
    const dir = await tempMemoryDir()
    const original = record({ status: 'registered' })
    await appendExperimentRecord(original, dir)

    const differentArms = {
      ...original,
      arms: [
        { name: 'A', prompt_hashes: ['hash-a', 'extra-hash'] },
        { name: 'B', prompt_hashes: ['hash-b'] },
      ],
    }
    await expect(appendExperimentRecord(differentArms, dir)).rejects.toThrow(/immutable/)
  })
})

describe('getActiveExperiment', () => {
  it('returns null when nothing is running', async () => {
    const dir = await tempMemoryDir()
    await appendExperimentRecord(record({ status: 'registered' }), dir)
    expect(await getActiveExperiment(dir)).toBe(null)
  })

  it('returns null for a running experiment with no arms', async () => {
    const dir = await tempMemoryDir()
    const noArms = record({ id: 'exp-no-arms', status: 'running' })
    // biome-ignore lint/performance/noDelete: constructing a no-arms fixture
    delete (noArms as { arms?: unknown }).arms
    await appendExperimentRecord(noArms, dir)
    expect(await getActiveExperiment(dir)).toBe(null)
  })

  it('returns the sole running-with-arms experiment', async () => {
    const dir = await tempMemoryDir()
    await appendExperimentRecord(record({ status: 'running' }), dir)
    const active = await getActiveExperiment(dir)
    expect(active?.id).toBe('exp-registry-test')
  })

  it('picks the earliest-registered among several running experiments, tiebroken by id', async () => {
    const dir = await tempMemoryDir()
    await appendExperimentRecord(
      record({ id: 'exp-later', status: 'running', registered_at: '2026-07-18T00:00:00.000Z' }),
      dir,
    )
    await appendExperimentRecord(
      record({ id: 'exp-earlier', status: 'running', registered_at: '2026-07-16T00:00:00.000Z' }),
      dir,
    )
    const active = await getActiveExperiment(dir)
    expect(active?.id).toBe('exp-earlier')
  })

  it('tiebreaks by ascending id when registered_at is identical', async () => {
    const dir = await tempMemoryDir()
    const sameTs = '2026-07-16T00:00:00.000Z'
    await appendExperimentRecord(
      record({ id: 'exp-zzz', status: 'running', registered_at: sameTs }),
      dir,
    )
    await appendExperimentRecord(
      record({ id: 'exp-aaa', status: 'running', registered_at: sameTs }),
      dir,
    )
    const active = await getActiveExperiment(dir)
    expect(active?.id).toBe('exp-aaa')
  })
})
