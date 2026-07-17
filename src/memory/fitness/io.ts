import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getMemoryDir } from '../../utils/path.ts'
import { readCalibrationRecords } from '../calibration/stats.ts'
import { readEpisodes } from '../episodes/store.ts'
import { type JournalEvent, isKnownJournalEvent, parseJournalEvent } from '../events.ts'
import { loadAllRulesIncludingArchived } from '../rules/store.ts'
import type { FitnessInput } from './dashboard.ts'

export const sessionStatsRecordSchema = z.object({
  ts: z.string(),
  session_id: z.string(),
  model: z.string(),
  turns: z.number(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
  cost_usd: z.number(),
  priced: z.boolean(),
  context_utilization: z.number(),
  compact_count: z.number(),
  duration_ms: z.number(),
})

export type SessionStatsRecord = z.infer<typeof sessionStatsRecordSchema>

export interface StatsReadResult {
  row_count: number
  records: SessionStatsRecord[]
}

export interface JournalReadResult {
  line_count: number
  events: JournalEvent[]
}

export async function readJournalEvents(
  filePath: string = path.join(getMemoryDir(), 'journal.jsonl'),
): Promise<JournalReadResult> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch {
    return { line_count: 0, events: [] }
  }

  let lineCount = 0
  const events: JournalEvent[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    lineCount += 1
    try {
      const event = parseJournalEvent(JSON.parse(line))
      if (event && isKnownJournalEvent(event)) events.push(event)
    } catch {
      // Raw coverage includes malformed lines, but metrics only consume known events.
    }
  }
  return { line_count: lineCount, events }
}

export async function readStatsRecords(
  filePath: string = path.join(getMemoryDir(), 'stats.jsonl'),
): Promise<StatsReadResult> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch {
    return { row_count: 0, records: [] }
  }

  let rowCount = 0
  const lastBySession = new Map<string, SessionStatsRecord>()
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = sessionStatsRecordSchema.safeParse(JSON.parse(line))
      if (!parsed.success) continue
      rowCount += 1
      lastBySession.set(parsed.data.session_id, parsed.data)
    } catch {
      // Malformed rows are not authoritative stats records.
    }
  }

  return { row_count: rowCount, records: [...lastBySession.values()] }
}

export async function loadFitnessInput(memoryDir: string = getMemoryDir()): Promise<FitnessInput> {
  const [journal, episodes, rules, calibrationRecords, stats] = await Promise.all([
    readJournalEvents(path.join(memoryDir, 'journal.jsonl')),
    readEpisodes(path.join(memoryDir, 'episodes.jsonl')),
    loadAllRulesIncludingArchived(path.join(memoryDir, 'rules')),
    readCalibrationRecords(path.join(memoryDir, 'calibration.jsonl')),
    readStatsRecords(path.join(memoryDir, 'stats.jsonl')),
  ])
  return {
    journal,
    episodes,
    rules,
    calibration_records: calibrationRecords,
    stats,
  }
}
