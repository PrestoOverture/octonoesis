import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readJournalEvents, readStatsRecords } from '../../../../src/memory/fitness/io.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function statsRow(sessionId: string, cost: number, priced = true) {
  return {
    ts: '2026-06-01T00:00:00.000Z',
    session_id: sessionId,
    model: 'test-model',
    turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 },
    cost_usd: cost,
    priced,
    context_utilization: 0.1,
    compact_count: 0,
    duration_ms: 100,
  }
}

describe('fitness ledger I/O', () => {
  it('reads stats with the last valid row winning per session', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-fitness-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'stats.jsonl')
    await fs.writeFile(
      file,
      [
        JSON.stringify(statsRow('duplicate', 99)),
        JSON.stringify(statsRow('unpriced', 50, false)),
        '{malformed',
        JSON.stringify(statsRow('duplicate', 12)),
      ].join('\n'),
    )

    const result = await readStatsRecords(file)

    expect(result.row_count).toBe(3)
    expect(result.records.length).toBe(2)
    expect(result.records.find((row) => row.session_id === 'duplicate')?.cost_usd).toBe(12)
    expect(result.records.find((row) => row.session_id === 'unpriced')?.priced).toBe(false)
  })

  it('counts journal lines while skipping malformed and unknown future events', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-fitness-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'journal.jsonl')
    await fs.writeFile(
      file,
      [
        JSON.stringify({
          kind: 'tool',
          schema_version: 1,
          ts: '2026-06-01T00:00:00.000Z',
          session_id: 'known',
          tool: 'Bash',
          input_digest: 'digest',
          outcome: 'success',
          error_class: null,
          duration_ms: 1,
        }),
        JSON.stringify({
          kind: 'future_dashboard_signal',
          schema_version: 99,
          ts: '2026-06-02T00:00:00.000Z',
          session_id: 'future',
        }),
        '{malformed',
      ].join('\n'),
    )

    const result = await readJournalEvents(file)

    expect(result.line_count).toBe(3)
    expect(result.events.length).toBe(1)
    expect(result.events[0]?.kind).toBe('tool')
  })
})
