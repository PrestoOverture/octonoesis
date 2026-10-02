import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runSessionEndCalibration } from '../../../src/memory/calibration/hook'
import { readCalibrationRecords, rebuildCalibration } from '../../../src/memory/calibration/stats'
import { runSessionEndEpisodes } from '../../../src/memory/episodes/hook'
import { type StoredJournalEvent, segmentJournal } from '../../../src/memory/episodes/segment'
import { readEpisodes } from '../../../src/memory/episodes/store'
import {
  type JournalEvent,
  isKnownJournalEvent,
  parseJournalEvent,
} from '../../../src/memory/events'
import { readJournalEvents } from '../../../src/memory/fitness/io'
import {
  appendJournal,
  flushJournal,
  getJournalPosition,
  resetJournalPositions,
} from '../../../src/memory/journal'
import { restoreEnv } from '../../helpers/env'

const session = 'S'
const ts = '2026-10-01T00:00:00Z'
const events: JournalEvent[] = [
  {
    ts,
    session_id: session,
    kind: 'tool',
    tool: 'Bash',
    input_digest: 'a',
    outcome: 'failure',
    duration_ms: 1,
    error_class: 'TypeError',
    fingerprints: [
      { coarse: 'bash|TypeError', medium: 'bash|TypeError|a.ts', fine: 'bash|TypeError|a.ts|x' },
    ],
  },
  {
    ts,
    session_id: session,
    kind: 'verify',
    verdict: 'PASS',
    fingerprints: [],
    command: 'bun test',
    exit_code: 0,
    stale: false,
  },
  {
    ts,
    session_id: session,
    kind: 'session',
    exit_reason: 'completed',
    model: 'test',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
]
const poison = JSON.stringify({
  ...events[0],
  session_id: session,
  fingerprints: [
    { coarse: 'poison|Error', medium: 'poison|Error|b.ts', fine: 'poison|Error|b.ts|x' },
  ],
})

async function outputs(dir: string) {
  await runSessionEndEpisodes(session, dir)
  await runSessionEndCalibration(session, dir)
  return {
    episodes: await readEpisodes(path.join(dir, 'episodes.jsonl')),
    calibration: await readCalibrationRecords(path.join(dir, 'calibration.jsonl')),
  }
}
async function clearOutputs(dir: string) {
  for (const name of ['episodes.jsonl', 'calibration.jsonl'])
    await fs.rm(path.join(dir, name), { force: true })
}
async function fixture(run: (dir: string, file: string) => Promise<void>) {
  const original = process.env.OCTONOESIS_MEMORY_DIR
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-session-'))
  process.env.OCTONOESIS_MEMORY_DIR = dir
  resetJournalPositions()
  try {
    await run(dir, path.join(dir, 'journal.jsonl'))
  } finally {
    await flushJournal()
    resetJournalPositions()
    restoreEnv('OCTONOESIS_MEMORY_DIR', original)
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('both session hooks ignore same-length poisoned prefix before captured start', async () => {
  await fixture(async (dir, file) => {
    const prefix = `${' '.repeat(Buffer.byteLength(poison))}\n\n{"torn":`
    await fs.writeFile(file, prefix)
    for (const event of events) appendJournal(event)
    await flushJournal()
    const position = getJournalPosition(file, session)
    expect(position).toEqual({
      offset: Buffer.byteLength(prefix.slice(0, prefix.lastIndexOf('\n') + 1)),
      line: 3,
    })
    const expected = await outputs(dir)
    expect(expected.episodes.length).toBe(1)
    expect(expected.calibration.length).toBe(1)
    await clearOutputs(dir)
    const handle = await fs.open(file, 'r+')
    try {
      await handle.write(Buffer.from(`${poison}\n\n`), 0, Buffer.byteLength(poison) + 2, 0)
    } finally {
      await handle.close()
    }
    expect(await outputs(dir)).toEqual(expected)
    // Prove the injected prefix would change a full read.
    await clearOutputs(dir)
    resetJournalPositions()
    const full = await outputs(dir)
    expect(full.episodes).not.toEqual(expected.episodes)
    expect(full.calibration).not.toEqual(expected.calibration)
  })
})

for (const invalid of ['none', 'boundary', 'size'] as const) {
  test(`both hooks fall back to physical full-file segmentation: ${invalid}`, async () => {
    await fixture(async (dir, file) => {
      if (invalid !== 'none') {
        await fs.writeFile(file, `${' '.repeat(9000)}\n`)
        for (const event of events) appendJournal(event)
        await flushJournal()
      }
      const content = `${JSON.stringify({ ...events[0], session_id: 'other' })}\n\n \n{"torn":\n${events.map((event) => JSON.stringify(event)).join('\n')}\n`
      await fs.writeFile(file, invalid === 'boundary' ? `${'x'.repeat(9001)}\n${content}` : content)
      const raw = await fs.readFile(file, 'utf8')
      if (invalid === 'size') expect(Buffer.byteLength(raw) < 9001).toBe(true)
      if (invalid === 'boundary') expect(Buffer.from(raw)[9000]).toBe(120)
      const full = raw.split('\n').flatMap((text, i) => {
        try {
          const event = parseJournalEvent(JSON.parse(text))
          return event && isKnownJournalEvent(event) && event.session_id === session
            ? [{ event: event as StoredJournalEvent, line: i + 1 }]
            : []
        } catch {
          return []
        }
      })
      const expected = segmentJournal(full, 1)
      const actual = await outputs(dir)
      expect(actual.episodes).toEqual(expected)
      await rebuildCalibration(file, path.join(dir, 'rebuilt.jsonl'))
      expect(actual.calibration).toEqual(
        await readCalibrationRecords(path.join(dir, 'rebuilt.jsonl')),
      )
      const journal = await readJournalEvents(file)
      expect(journal.line_count).toBe(raw.split('\n').filter((text) => text.trim()).length)
      if (invalid !== 'none') {
        await clearOutputs(dir)
        resetJournalPositions()
        expect(await outputs(dir)).toEqual(actual)
      }
    })
  })
}

test('queued captures are once per path/session, including missing journals and no-session', async () => {
  const [first, second, third] = events
  if (!first || !second || !third) throw new Error('Missing fixture events')
  await fixture(async (dir, file) => {
    appendJournal(first)
    appendJournal(second)
    appendJournal({ ...third, session_id: 'next' })
    appendJournal({ ...third, session_id: 'no-session' })
    await flushJournal()
    expect(getJournalPosition(file, session)).toEqual({ offset: 0, line: 1 })
    const raw = await fs.readFile(file, 'utf8')
    const prefix = `${raw.split('\n').slice(0, 2).join('\n')}\n`
    expect(getJournalPosition(file, 'next')).toEqual({ offset: Buffer.byteLength(prefix), line: 3 })
    expect(getJournalPosition(file, 'no-session')).toBeUndefined()
    const other = path.join(dir, 'other')
    process.env.OCTONOESIS_MEMORY_DIR = other
    appendJournal(first)
    await flushJournal()
    expect(getJournalPosition(path.join(other, 'journal.jsonl'), session)).toEqual({
      offset: 0,
      line: 1,
    })
  })
})
