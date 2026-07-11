import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  appendSessionStats,
  createSessionState,
  flushSessionStats,
  formatSessionSummary,
} from '../../../src/state/session'

const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
let memoryDir = ''

beforeEach(async () => {
  memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-session-state-'))
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
})

afterEach(async () => {
  await flushSessionStats()
  await fs.rm(memoryDir, { recursive: true, force: true })
  if (originalMemoryDir === undefined) {
    Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
  } else {
    process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
  }
})

describe('session observability state', () => {
  it('creates a zeroed state for the supplied session and model', () => {
    const before = Date.now()
    const state = createSessionState('session-29', 'claude-haiku-4-5')
    const after = Date.now()

    expect(state).toEqual({
      sessionId: 'session-29',
      startTime: state.startTime,
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
      contextUtilization: 0,
      compactCount: 0,
      model: 'claude-haiku-4-5',
    })
    expect(state.startTime >= before && state.startTime <= after).toBe(true)
  })

  it('appends complete superseding rows for the same TUI session', async () => {
    const state = createSessionState('session-29', 'claude-haiku-4-5')
    state.turns = 1
    state.usage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    }
    state.costUsd = 0.001
    state.contextUtilization = 0.25
    appendSessionStats(state, {
      priced: true,
      durationMs: 100,
      ts: '2026-07-11T00:00:00.000Z',
    })

    state.turns = 3
    state.usage.input_tokens = 350
    state.usage.output_tokens = 70
    state.costUsd = 0.0035
    state.contextUtilization = 0.4
    state.compactCount = 1
    appendSessionStats(state, {
      priced: true,
      durationMs: 500,
      ts: '2026-07-11T00:00:01.000Z',
    })
    await flushSessionStats()

    const rows = (await fs.readFile(path.join(memoryDir, 'stats.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(rows.length).toBe(2)
    expect(rows[0]?.session_id).toBe('session-29')
    expect(rows[1]).toEqual({
      ts: '2026-07-11T00:00:01.000Z',
      session_id: 'session-29',
      model: 'claude-haiku-4-5',
      turns: 3,
      usage: {
        input_tokens: 350,
        output_tokens: 70,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      },
      cost_usd: 0.0035,
      priced: true,
      context_utilization: 0.4,
      compact_count: 1,
      duration_ms: 500,
    })
  })

  it('captures the active memory directory at append time', async () => {
    const secondMemoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-session-state-'))
    try {
      appendSessionStats(createSessionState('first-dir', 'gpt-5-nano'), {
        priced: true,
        durationMs: 1,
      })
      process.env.OCTONOESIS_MEMORY_DIR = secondMemoryDir
      appendSessionStats(createSessionState('second-dir', 'gpt-5-nano'), {
        priced: true,
        durationMs: 2,
      })
      await flushSessionStats()

      expect(await fs.readFile(path.join(memoryDir, 'stats.jsonl'), 'utf8')).toContain('first-dir')
      expect(await fs.readFile(path.join(secondMemoryDir, 'stats.jsonl'), 'utf8')).toContain(
        'second-dir',
      )
    } finally {
      process.env.OCTONOESIS_MEMORY_DIR = memoryDir
      await fs.rm(secondMemoryDir, { recursive: true, force: true })
    }
  })

  it('formats the shared priced and unpriced exit-summary shapes', () => {
    const state = createSessionState('summary-session', 'claude-haiku-4-5')
    state.turns = 3
    state.usage = { input_tokens: 1_234, output_tokens: 56 }
    state.costUsd = 0.123456
    state.compactCount = 2

    expect(formatSessionSummary(state, true)).toBe(
      'Session summary: 3 turns | in: 1,234 | out: 56 | cost: $0.1235 | compactions: 2',
    )
    expect(formatSessionSummary(state, false)).toBe(
      'Session summary: 3 turns | in: 1,234 | out: 56 | cost: n/a | compactions: 2',
    )
  })
})
