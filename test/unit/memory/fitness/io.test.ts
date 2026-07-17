import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  loadFitnessInput,
  readJournalEvents,
  readStatsRecords,
} from '../../../../src/memory/fitness/io.ts'
import { archiveRule, saveRule } from '../../../../src/memory/rules/store.ts'
import type { RuleFile } from '../../../../src/memory/rules/types.ts'

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

  it('loadFitnessInput counts hot and archived rules once each, hot copy winning on a duplicate id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-fitness-'))
    tempDirs.push(dir)
    const rulesDir = path.join(dir, 'rules')
    await fs.mkdir(rulesDir, { recursive: true })

    function rule(overrides: Partial<RuleFile>): RuleFile {
      return {
        id: 'rule-default',
        triggers: {
          tools: ['Bash'],
          command_prefix: ['bun test'],
          error_signatures: ['bun-test|TypeError|src/a.ts'],
        },
        scope: 'repo',
        alpha: 2,
        beta: 2,
        confidence: 0.5,
        evidence: [],
        hits: 0,
        misses: 0,
        challenged_by: [],
        anchor: { file: 'src/a.ts' },
        status: 'candidate',
        user_confirmed: false,
        extractor_version: '0.2.0',
        model_id: 'test-model',
        prompt_hash: 'hash-a',
        created_at: '2026-06-01T00:00:00.000Z',
        last_matched_at: null,
        last_rebuilt_at: null,
        advice: 'Test advice.',
        ...overrides,
      }
    }

    // A hot-only active rule, an archive-only dormant rule, and a duplicate id present
    // in both places with different content -- the hot copy must be the one counted.
    await saveRule(rule({ id: 'rule-hot-only', status: 'active' }), rulesDir)
    await archiveRule(rule({ id: 'rule-archive-only', status: 'dormant' }), rulesDir)
    await archiveRule(
      rule({ id: 'rule-dup', status: 'superseded', hits: 1, advice: 'stale archived advice' }),
      rulesDir,
    )
    await saveRule(
      rule({ id: 'rule-dup', status: 'candidate', hits: 99, advice: 'fresh hot advice' }),
      rulesDir,
    )

    const input = await loadFitnessInput(dir)
    const byId = new Map(input.rules.map((r) => [r.id, r]))

    expect(input.rules.length).toBe(3)
    expect(byId.get('rule-hot-only')?.status).toBe('active')
    expect(byId.get('rule-archive-only')?.status).toBe('dormant')
    expect(byId.get('rule-dup')?.status).toBe('candidate')
    expect(byId.get('rule-dup')?.hits).toBe(99)
    expect(byId.get('rule-dup')?.advice).toBe('fresh hot advice')
  })
})
