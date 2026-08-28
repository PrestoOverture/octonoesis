import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  type CalibrationRecord,
  aggregateCalibrationStats,
  appendCalibrationRecords,
  readCalibrationRecords,
  rebuildCalibration,
} from '../../../../src/memory/calibration/stats.ts'
import { getMemoryDir } from '../../../../src/utils/path.ts'

const TEST_DIR = path.join(__dirname, '../../../../test-calibration-memory')

describe('Calibration Stats Module', () => {
  const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR

  beforeEach(async () => {
    process.env.OCTONOESIS_MEMORY_DIR = TEST_DIR
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true })
    } catch {}
  })

  afterEach(async () => {
    if (originalMemoryDir === undefined) {
      Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true })
    } catch {}
  })

  it('should return empty list when no calibration file exists', async () => {
    const records = await readCalibrationRecords()
    expect(records).toEqual([])
  })

  it('should round-trip save and read calibration records', async () => {
    const mockRecord: CalibrationRecord = {
      session_id: 'sess-123',
      ts: new Date().toISOString(),
      bucket_key: 'bun-test|TypeError',
      model_id: 'gpt-5-nano',
      attempt_count: 3,
      first_attempt_success: false,
      user_modifications: 1,
      user_reverts: 0,
      resolved: true,
    }

    await appendCalibrationRecords([mockRecord])

    const records = await readCalibrationRecords()
    expect(records.length).toBe(1)
    expect(records[0]).toEqual(mockRecord)
  })

  it('should aggregate statistics correctly', () => {
    const records: CalibrationRecord[] = [
      {
        session_id: 'sess-1',
        ts: '2026-06-20T00:00:00.000Z',
        bucket_key: 'bun-test|TypeError',
        model_id: 'gpt-5-nano',
        attempt_count: 2,
        first_attempt_success: false,
        user_modifications: 1,
        user_reverts: 0,
        resolved: true,
      },
      {
        session_id: 'sess-2',
        ts: '2026-06-20T01:00:00.000Z',
        bucket_key: 'bun-test|TypeError',
        model_id: 'gpt-5-nano',
        attempt_count: 1,
        first_attempt_success: true,
        user_modifications: 0,
        user_reverts: 0,
        resolved: true,
      },
      {
        session_id: 'sess-3',
        ts: '2026-06-20T02:00:00.000Z',
        bucket_key: 'bun-test|TypeError',
        model_id: 'gpt-5-nano',
        attempt_count: 3,
        first_attempt_success: false,
        user_modifications: 2,
        user_reverts: 1,
        resolved: false,
      },
      {
        session_id: 'sess-4',
        ts: '2026-06-20T03:00:00.000Z',
        bucket_key: 'tsc|SyntaxError',
        model_id: 'gpt-5-nano',
        attempt_count: 1,
        first_attempt_success: true,
        user_modifications: 0,
        user_reverts: 0,
        resolved: true,
      },
    ]

    const stats = aggregateCalibrationStats(records)
    expect(stats.length).toBe(2)

    const typeErrorStats = stats.find((s) => s.bucket_key === 'bun-test|TypeError')
    expect(typeErrorStats).toBeDefined()
    expect(typeErrorStats?.model_id).toBe('gpt-5-nano')
    expect(typeErrorStats?.total_attempts).toBe(3)
    expect(typeErrorStats?.first_attempt_success).toBe(1)
    expect(typeErrorStats?.user_modifications).toBe(3)
    expect(typeErrorStats?.user_reverts).toBe(1)
    expect(typeErrorStats?.alpha).toBe(3)
    expect(typeErrorStats?.beta).toBe(4)
    expect(typeErrorStats?.posterior_mean).toBeCloseTo(3 / 7, 5)
    expect(typeErrorStats?.credible_interval).toBeDefined()
    expect(typeErrorStats?.credible_interval[0]).toBeLessThan(
      typeErrorStats?.credible_interval[1] ?? 1,
    )

    const syntaxErrorStats = stats.find((s) => s.bucket_key === 'tsc|SyntaxError')
    expect(syntaxErrorStats).toBeDefined()
    expect(syntaxErrorStats?.total_attempts).toBe(1)
    expect(syntaxErrorStats?.first_attempt_success).toBe(1)
    expect(syntaxErrorStats?.alpha).toBe(3)
    expect(syntaxErrorStats?.beta).toBe(2)
    expect(syntaxErrorStats?.posterior_mean).toBe(0.6)
    expect(syntaxErrorStats?.credible_interval).toBeDefined()
  })

  it('should rebuild calibration data from journal events', async () => {
    const journalPath = path.join(TEST_DIR, 'journal.jsonl')
    const calibrationPath = path.join(TEST_DIR, 'calibration.jsonl')

    await fs.mkdir(TEST_DIR, { recursive: true })

    const mockJournalContent = `${[
      // Session 1: Succeeded on 1st attempt, no user intervention
      JSON.stringify({
        ts: '2026-06-20T00:00:00.000Z',
        session_id: 'sess-1',
        kind: 'tool',
        tool: 'Bash',
      }),
      JSON.stringify({
        ts: '2026-06-20T00:00:01.000Z',
        session_id: 'sess-1',
        kind: 'verify',
        verdict: 'PASS',
        fingerprints: [],
        command: 'bun test',
        exit_code: 0,
        stale: false,
      }),
      JSON.stringify({
        ts: '2026-06-20T00:00:02.000Z',
        session_id: 'sess-1',
        kind: 'session',
        exit_reason: 'completed',
        usage: { input_tokens: 10, output_tokens: 20 },
        model: 'gpt-5-nano',
      }),

      // Session 2: Failed 1st, then passed 2nd verify. Had a user deny.
      JSON.stringify({
        ts: '2026-06-20T01:00:00.000Z',
        session_id: 'sess-2',
        kind: 'tool',
        tool: 'Bash',
      }),
      JSON.stringify({
        ts: '2026-06-20T01:00:01.000Z',
        session_id: 'sess-2',
        kind: 'verify',
        verdict: 'FAIL',
        fingerprints: [
          {
            tool: 'bun-test',
            error_class: 'TypeError',
            file: 'src/buggy.ts',
            expression: 'evaluating user',
            coarse: 'bun-test|TypeError',
            medium: 'bun-test|TypeError|src/buggy.ts',
            fine: 'bun-test|TypeError|src/buggy.ts|evaluating user',
          },
        ],
        command: 'bun test',
        exit_code: 1,
        stale: false,
      }),
      JSON.stringify({
        ts: '2026-06-20T01:00:02.000Z',
        session_id: 'sess-2',
        kind: 'permission',
        decision: 'deny',
        key: 'abc',
      }),
      JSON.stringify({
        ts: '2026-06-20T01:00:03.000Z',
        session_id: 'sess-2',
        kind: 'verify',
        verdict: 'PASS',
        fingerprints: [],
        command: 'bun test',
        exit_code: 0,
        stale: false,
      }),
      JSON.stringify({
        ts: '2026-06-20T01:00:04.000Z',
        session_id: 'sess-2',
        kind: 'session',
        exit_reason: 'completed',
        usage: { input_tokens: 15, output_tokens: 30 },
        model: 'gpt-5-nano',
      }),
    ].join('\n')}\n`

    await fs.writeFile(journalPath, mockJournalContent, 'utf8')

    await rebuildCalibration(journalPath, calibrationPath)

    const records = await readCalibrationRecords()
    expect(records.length).toBe(2)

    const r1 = records.find((r) => r.session_id === 'sess-1')
    expect(r1).toBeDefined()
    expect(r1?.bucket_key).toBe('Bash') // no fingerprints, falls back to first tool
    expect(r1?.attempt_count).toBe(1)
    expect(r1?.first_attempt_success).toBe(true)
    expect(r1?.user_modifications).toBe(0)
    expect(r1?.resolved).toBe(true)
    expect(r1?.model_id).toBe('gpt-5-nano')

    const r2 = records.find((r) => r.session_id === 'sess-2')
    expect(r2).toBeDefined()
    expect(r2?.bucket_key).toBe('bun-test|TypeError') // extracted from fingerprints
    expect(r2?.attempt_count).toBe(2)
    expect(r2?.first_attempt_success).toBe(false)
    expect(r2?.user_modifications).toBe(1)
    expect(r2?.resolved).toBe(true)
    expect(r2?.model_id).toBe('gpt-5-nano')
  })

  it('should skip sessions with no verify events when rebuilding calibration data', async () => {
    const journalPath = path.join(TEST_DIR, 'journal.jsonl')
    const calibrationPath = path.join(TEST_DIR, 'calibration.jsonl')

    await fs.mkdir(TEST_DIR, { recursive: true })

    const mockJournalContent = `${[
      JSON.stringify({
        ts: '2026-06-20T00:00:00.000Z',
        session_id: 'sess-no-verify',
        kind: 'tool',
        tool: 'Read',
      }),
      JSON.stringify({
        ts: '2026-06-20T00:00:01.000Z',
        session_id: 'sess-no-verify',
        kind: 'session',
        exit_reason: 'completed',
        usage: { input_tokens: 5, output_tokens: 5 },
        model: 'gpt-5-nano',
      }),
    ].join('\n')}\n`

    await fs.writeFile(journalPath, mockJournalContent, 'utf8')

    await rebuildCalibration(journalPath, calibrationPath)

    const records = await readCalibrationRecords()
    expect(records.length).toBe(0)
  })
})
