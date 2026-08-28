import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runSessionEndCalibration } from '../../../../src/memory/calibration/hook.ts'
import { readCalibrationRecords } from '../../../../src/memory/calibration/stats.ts'

const TEST_DIR = path.join(__dirname, '../../../../test-calibration-hook-memory')

describe('Calibration Session-End Hook', () => {
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

  it('should analyze session events and record new calibration record', async () => {
    const journalPath = path.join(TEST_DIR, 'journal.jsonl')
    await fs.mkdir(TEST_DIR, { recursive: true })

    const mockEvents = `${[
      JSON.stringify({
        ts: '2026-06-20T05:00:00.000Z',
        session_id: 'sess-abc',
        kind: 'tool',
        tool: 'Bash',
      }),
      JSON.stringify({
        ts: '2026-06-20T05:00:01.000Z',
        session_id: 'sess-abc',
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
        ts: '2026-06-20T05:00:02.000Z',
        session_id: 'sess-abc',
        kind: 'permission',
        decision: 'deny',
        key: 'x',
      }),
      JSON.stringify({
        ts: '2026-06-20T05:00:03.000Z',
        session_id: 'sess-abc',
        kind: 'user',
        cancel: true,
        digest: 'hash',
      }),
      JSON.stringify({
        ts: '2026-06-20T05:00:04.000Z',
        session_id: 'sess-abc',
        kind: 'session',
        exit_reason: 'user_cancel',
        usage: { input_tokens: 5, output_tokens: 5 },
        model: 'claude-haiku-4-5-20251001',
      }),
    ].join('\n')}\n`

    await fs.writeFile(journalPath, mockEvents, 'utf8')

    await runSessionEndCalibration('sess-abc')

    const records = await readCalibrationRecords()
    expect(records.length).toBe(1)

    const record = records[0]
    expect(record).toBeDefined()
    if (!record) return
    expect(record.session_id).toBe('sess-abc')
    expect(record.bucket_key).toBe('bun-test|TypeError')
    expect(record.model_id).toBe('claude-haiku-4-5-20251001')
    expect(record.attempt_count).toBe(1)
    expect(record.first_attempt_success).toBe(false)
    expect(record.user_modifications).toBe(1)
    // user_reverts should be 2 (1 from user cancel, 1 from session user_cancel exit reason)
    expect(record.user_reverts).toBe(2)
    expect(record.resolved).toBe(false)

    // Verify idempotency: running it again shouldn't write a duplicate record
    await runSessionEndCalibration('sess-abc')
    const finalRecords = await readCalibrationRecords()
    expect(finalRecords.length).toBe(1)
  })

  it('should skip recording when session has no verify events', async () => {
    const journalPath = path.join(TEST_DIR, 'journal.jsonl')
    await fs.mkdir(TEST_DIR, { recursive: true })

    const mockEvents = `${[
      JSON.stringify({
        ts: '2026-06-20T05:00:00.000Z',
        session_id: 'sess-xyz',
        kind: 'tool',
        tool: 'Bash',
      }),
      JSON.stringify({
        ts: '2026-06-20T05:00:04.000Z',
        session_id: 'sess-xyz',
        kind: 'session',
        exit_reason: 'completed',
        usage: { input_tokens: 5, output_tokens: 5 },
        model: 'claude-haiku-4-5-20251001',
      }),
    ].join('\n')}\n`

    await fs.writeFile(journalPath, mockEvents, 'utf8')

    await runSessionEndCalibration('sess-xyz')

    const records = await readCalibrationRecords()
    expect(records.length).toBe(0)
  })
})
