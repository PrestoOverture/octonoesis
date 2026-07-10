import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSessionEndCalibration } from '../../../src/memory/calibration/hook'
import {
  aggregateCalibrationStats,
  readCalibrationRecords,
  rebuildCalibration,
} from '../../../src/memory/calibration/stats'
import { runSessionEndEpisodes } from '../../../src/memory/episodes/hook'
import { readEpisodes } from '../../../src/memory/episodes/store'
import {
  EVENT_SCHEMA_VERSIONS,
  isKnownJournalEvent,
  parseJournalEvent,
} from '../../../src/memory/events'
import { appendJournal, flushJournal } from '../../../src/memory/journal'

const SESSION_ID = 'replay-session'

const OLD_EVENTS = [
  {
    kind: 'user',
    digest: 'task-digest',
    cancel: false,
    ts: '2026-07-10T00:00:00.000Z',
    session_id: SESSION_ID,
  },
  {
    kind: 'turn',
    turn: 1,
    ts: '2026-07-10T00:00:01.000Z',
    session_id: SESSION_ID,
  },
  {
    kind: 'tool',
    tool: 'Bash',
    input_digest: 'bash-digest',
    outcome: 'failure',
    error_class: 'TypeError',
    duration_ms: 10,
    cmd: 'bun test',
    exit_code: 1,
    fingerprints: [
      {
        tool: 'bun-test',
        error_class: 'TypeError',
        file: 'src/bug.ts',
        expression: 'reading value',
        coarse: 'bun-test|TypeError',
        medium: 'bun-test|TypeError|src/bug.ts',
        fine: 'bun-test|TypeError|src/bug.ts|reading value',
      },
    ],
    ts: '2026-07-10T00:00:02.000Z',
    session_id: SESSION_ID,
  },
  {
    kind: 'permission',
    decision: 'allow_once',
    key: 'Bash:bash-digest',
    ts: '2026-07-10T00:00:03.000Z',
    session_id: SESSION_ID,
  },
  {
    kind: 'verify',
    verdict: 'PASS',
    fingerprints: [],
    command: 'bun test',
    exit_code: 0,
    stale: false,
    ts: '2026-07-10T00:00:04.000Z',
    session_id: SESSION_ID,
  },
  {
    kind: 'session',
    exit_reason: 'completed',
    usage: { input_tokens: 100, output_tokens: 20 },
    model: 'test-model',
    ts: '2026-07-10T00:00:05.000Z',
    session_id: SESSION_ID,
  },
]

const V2_EVENTS = [
  {
    kind: 'compact',
    pre_tokens: 100,
    post_tokens: 40,
    summary_length: 200,
    ts: '2026-07-10T00:00:06.000Z',
    session_id: SESSION_ID,
    schema_version: 2,
  },
  {
    kind: 'memory_write',
    name: 'project-style',
    type: 'project',
    action: 'create',
    ts: '2026-07-10T00:00:07.000Z',
    session_id: SESSION_ID,
    schema_version: 2,
  },
  {
    kind: 'skill',
    skill: 'review',
    context: 'fork',
    duration_ms: 8,
    ts: '2026-07-10T00:00:08.000Z',
    session_id: SESSION_ID,
    schema_version: 2,
  },
  {
    kind: 'task',
    task_id: 'task-1',
    type: 'agent',
    status: 'completed',
    duration_ms: 12,
    ts: '2026-07-10T00:00:09.000Z',
    session_id: SESSION_ID,
    schema_version: 2,
  },
  {
    kind: 'hook',
    hook_event: 'post_tool',
    hook_type: 'function',
    duration_ms: 2,
    outcome: 'success',
    ts: '2026-07-10T00:00:10.000Z',
    session_id: SESSION_ID,
    schema_version: 2,
  },
]

const FUTURE_EVENT = {
  kind: 'future_kind',
  extra: { preserved: true },
  ts: '2026-07-10T00:00:11.000Z',
  session_id: SESSION_ID,
  schema_version: 9,
}

async function withMemoryDir<T>(run: (memoryDir: string) => Promise<T>): Promise<T> {
  const original = process.env.OCTONOESIS_MEMORY_DIR
  const memoryDir = await mkdtemp(join(tmpdir(), 'octonoesis-journal-v2-'))
  try {
    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    return await run(memoryDir)
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = original
    }
    await rm(memoryDir, { recursive: true, force: true })
  }
}

async function writeJournal(memoryDir: string, events: unknown[]): Promise<void> {
  await writeFile(
    join(memoryDir, 'journal.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  )
}

describe('Journal v2 replay compatibility', () => {
  it('stamps persisted v0.2 and v2 events with their schema versions', async () => {
    await withMemoryDir(async (memoryDir) => {
      appendJournal({
        kind: 'turn',
        turn: 1,
        session_id: 'version-session',
      })
      appendJournal({
        kind: 'compact',
        pre_tokens: 100,
        post_tokens: 40,
        summary_length: 200,
        session_id: 'version-session',
      })
      await flushJournal()

      const content = await readFile(join(memoryDir, 'journal.jsonl'), 'utf8')
      const events = content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))

      expect(events[0]?.schema_version).toBe(1)
      expect(events[1]?.schema_version).toBe(2)
    })
  })

  it('triages all known kinds, future kinds, and malformed values', () => {
    const knownEvents = [...OLD_EVENTS, ...V2_EVENTS].map((event) => ({
      ...event,
      schema_version: EVENT_SCHEMA_VERSIONS[event.kind as keyof typeof EVENT_SCHEMA_VERSIONS],
    }))

    for (const raw of knownEvents) {
      const parsed = parseJournalEvent(raw)
      expect(parsed).not.toBe(null)
      if (!parsed) continue
      expect(isKnownJournalEvent(parsed)).toBe(true)
      expect(parsed.ts).toBe(raw.ts)
      expect(parsed.session_id).toBe(raw.session_id)
      expect(parsed.schema_version).toBe(raw.schema_version)
    }

    const future = parseJournalEvent(FUTURE_EVENT)
    expect(future).toEqual(FUTURE_EVENT)
    if (future) {
      expect(isKnownJournalEvent(future)).toBe(false)
    }
    expect(parseJournalEvent({ no_kind: true })).toBe(null)
    expect(parseJournalEvent(42)).toBe(null)
  })

  it('keeps episode and calibration outputs identical under a 12-kind replay', async () => {
    const baselineDir = await mkdtemp(join(tmpdir(), 'octonoesis-replay-old-'))
    const mixedDir = await mkdtemp(join(tmpdir(), 'octonoesis-replay-mixed-'))

    try {
      await writeJournal(baselineDir, OLD_EVENTS)
      await writeJournal(mixedDir, [...OLD_EVENTS, ...V2_EVENTS, FUTURE_EVENT])

      await runSessionEndEpisodes(SESSION_ID, baselineDir)
      await runSessionEndEpisodes(SESSION_ID, mixedDir)
      const baselineEpisodes = await readEpisodes(join(baselineDir, 'episodes.jsonl'))
      const mixedEpisodes = await readEpisodes(join(mixedDir, 'episodes.jsonl'))

      expect(mixedEpisodes).toEqual(baselineEpisodes)
      expect(baselineEpisodes.length).toBe(1)

      const baselineCalibrationPath = join(baselineDir, 'calibration.jsonl')
      const mixedCalibrationPath = join(mixedDir, 'calibration.jsonl')
      await rebuildCalibration(join(baselineDir, 'journal.jsonl'), baselineCalibrationPath)
      await rebuildCalibration(join(mixedDir, 'journal.jsonl'), mixedCalibrationPath)

      const baselineStats = aggregateCalibrationStats(
        await readCalibrationRecords(baselineCalibrationPath),
      )
      const mixedStats = aggregateCalibrationStats(
        await readCalibrationRecords(mixedCalibrationPath),
      )

      expect(mixedStats).toEqual(baselineStats)
      expect(baselineStats.length).toBe(1)
    } finally {
      await rm(baselineDir, { recursive: true, force: true })
      await rm(mixedDir, { recursive: true, force: true })
    }
  })

  it('keeps session-end calibration output identical under mixed-version replay', async () => {
    const baselineDir = await mkdtemp(join(tmpdir(), 'octonoesis-hook-old-'))
    const mixedDir = await mkdtemp(join(tmpdir(), 'octonoesis-hook-mixed-'))

    try {
      await writeJournal(baselineDir, OLD_EVENTS)
      await writeJournal(mixedDir, [FUTURE_EVENT, ...OLD_EVENTS, ...V2_EVENTS])

      await runSessionEndCalibration(SESSION_ID, baselineDir)
      await runSessionEndCalibration(SESSION_ID, mixedDir)

      const baselineRecords = await readCalibrationRecords(join(baselineDir, 'calibration.jsonl'))
      const mixedRecords = await readCalibrationRecords(join(mixedDir, 'calibration.jsonl'))

      expect(mixedRecords).toEqual(baselineRecords)
      expect(baselineRecords.length >= 1).toBe(true)
    } finally {
      await rm(baselineDir, { recursive: true, force: true })
      await rm(mixedDir, { recursive: true, force: true })
    }
  })
})
