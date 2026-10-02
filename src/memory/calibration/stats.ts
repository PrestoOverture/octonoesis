import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from '../../utils/atomicWrite.ts'
import { getMemoryDir } from '../../utils/path.ts'
import { isKnownJournalEvent, parseJournalEvent } from '../events.ts'
import type { Fingerprint } from '../fingerprint/extract.ts'
import { readJournalTextBatches } from '../journalReader'
import { createPrior, credibleInterval, posteriorMean, update } from './beta.ts'
import { bucketKey } from './bucket.ts'

export const calibrationRecordSchema = z.object({
  session_id: z.string(),
  ts: z.string(),
  bucket_key: z.string(),
  model_id: z.string(),
  attempt_count: z.number(),
  first_attempt_success: z.boolean(),
  user_modifications: z.number(),
  user_reverts: z.number(),
  resolved: z.boolean(),
})

export type CalibrationRecord = z.infer<typeof calibrationRecordSchema>

/** Aggregated statistical metrics and Beta distribution parameters for an error signature bucket. */
export interface BucketStats {
  bucket_key: string
  model_id: string
  alpha: number
  beta: number
  posterior_mean: number
  credible_interval: [number, number]
  total_attempts: number
  first_attempt_success: number
  user_modifications: number
  user_reverts: number
}

/**
 * Reads all calibration records from calibration.jsonl.
 * @param filePath The path to the calibration records file.
 * @returns A promise resolving to an array of calibration records.
 */
export async function readCalibrationRecords(
  filePath: string = path.join(getMemoryDir(), 'calibration.jsonl'),
): Promise<CalibrationRecord[]> {
  try {
    const fileContent = await fs.readFile(filePath, 'utf8')
    const lines = fileContent.split('\n')
    const records: CalibrationRecord[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const parsed = JSON.parse(trimmed)
        const validated = calibrationRecordSchema.parse(parsed)
        records.push(validated)
      } catch {
        // Skip malformed records
      }
    }

    return records
  } catch (err) {
    // Return empty if file not found
    return []
  }
}

/**
 * Appends calibration records to calibration.jsonl.
 * @param records The calibration records to append.
 * @param filePath The path to the calibration records file.
 */
export async function appendCalibrationRecords(
  records: CalibrationRecord[],
  filePath: string = path.join(getMemoryDir(), 'calibration.jsonl'),
): Promise<void> {
  if (records.length === 0) return

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  const lines = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  await fs.appendFile(filePath, lines, 'utf8')
}

/**
 * Aggregates calibration records per bucket key and model ID.
 * @param records The array of calibration records to aggregate.
 * @returns The aggregated bucket stats.
 */
export function aggregateCalibrationStats(records: CalibrationRecord[]): BucketStats[] {
  const groups = new Map<string, CalibrationRecord[]>()

  for (const record of records) {
    const key = `${record.bucket_key}|${record.model_id}`
    let list = groups.get(key)
    if (!list) {
      list = []
      groups.set(key, list)
    }
    list.push(record)
  }

  const result: BucketStats[] = []
  for (const [key, list] of groups.entries()) {
    const lastPipeIndex = key.lastIndexOf('|')
    const bucket_key = key.slice(0, lastPipeIndex)
    const model_id = key.slice(lastPipeIndex + 1)

    const total_attempts = list.length
    const first_attempt_success = list.filter((r) => r.first_attempt_success).length
    const user_modifications = list.reduce((sum, r) => sum + r.user_modifications, 0)
    const user_reverts = list.reduce((sum, r) => sum + r.user_reverts, 0)

    let betaParams = createPrior()
    for (const record of list) {
      betaParams = update(betaParams, record.first_attempt_success)
    }

    const posterior_mean = posteriorMean(betaParams)
    const credible_interval = credibleInterval(betaParams, 0.95)

    result.push({
      bucket_key,
      model_id,
      alpha: betaParams.alpha,
      beta: betaParams.beta,
      posterior_mean,
      credible_interval,
      total_attempts,
      first_attempt_success,
      user_modifications,
      user_reverts,
    })
  }

  return result
}

/**
 * Rebuilds calibration.jsonl by parsing the entire journal.jsonl log.
 * @param journalPath The path to the journal file.
 * @param calibrationPath The path to the calibration file.
 */
export async function rebuildCalibration(
  journalPath: string,
  calibrationPath: string,
): Promise<void> {
  const sessions = new Map<
    string,
    {
      record: CalibrationRecord
      firstTool?: string
      firstFingerprint?: Fingerprint
      hasSession: boolean
      hasCancel: boolean
    }
  >()
  try {
    for await (const lines of readJournalTextBatches(journalPath)) {
      for (const text of lines) {
        if (!text.trim()) continue
        try {
          const event = parseJournalEvent(JSON.parse(text))
          if (!event || !isKnownJournalEvent(event)) continue
          const sessionId = event.session_id || 'no-session'
          let data = sessions.get(sessionId)
          if (!data) {
            data = {
              record: {
                session_id: sessionId,
                ts: event.ts || new Date().toISOString(),
                bucket_key: '',
                model_id: 'unknown-model',
                attempt_count: 0,
                first_attempt_success: false,
                user_modifications: 0,
                user_reverts: 0,
                resolved: false,
              },
              hasSession: false,
              hasCancel: false,
            }
            sessions.set(sessionId, data)
          }
          if (event.kind === 'tool' && data.firstTool === undefined) data.firstTool = event.tool
          if (
            (event.kind === 'tool' || event.kind === 'verify') &&
            !data.firstFingerprint &&
            event.fingerprints?.length
          ) {
            data.firstFingerprint = event.fingerprints[0]
          }
          if (event.kind === 'verify') {
            if (data.record.attempt_count === 0)
              data.record.first_attempt_success = event.verdict === 'PASS'
            data.record.attempt_count++
          }
          if (event.kind === 'permission' && event.decision === 'deny')
            data.record.user_modifications++
          if (event.kind === 'user' && event.cancel) data.record.user_reverts++
          if (event.kind === 'session') {
            if (!data.hasSession) {
              data.record.model_id = event.model || 'unknown-model'
              data.hasSession = true
            }
            if (event.exit_reason === 'user_cancel') data.hasCancel = true
            if (event.exit_reason === 'completed') data.record.resolved = true
          }
        } catch {
          // Skip malformed lines.
        }
      }
    }
  } catch {
    // Preserve the existing missing/unreadable journal behavior.
    try {
      await fs.unlink(calibrationPath)
    } catch {}
    return
  }
  const newRecords: CalibrationRecord[] = []
  for (const data of sessions.values()) {
    if (!data.record.attempt_count) continue
    data.record.bucket_key = bucketKey(
      data.firstFingerprint ? [data.firstFingerprint] : [],
      data.firstTool || 'unknown-tool',
    )
    if (data.hasCancel) data.record.user_reverts++
    newRecords.push(data.record)
  }

  // Write new records to calibration.jsonl (overwrite)
  const dir = path.dirname(calibrationPath)
  await fs.mkdir(dir, { recursive: true })

  if (newRecords.length === 0) {
    try {
      await fs.unlink(calibrationPath)
    } catch {}
  } else {
    const lines = `${newRecords.map((r) => JSON.stringify(r)).join('\n')}\n`
    await writeFileAtomic(calibrationPath, lines)
  }
}
