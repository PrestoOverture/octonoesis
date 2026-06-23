import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { getMemoryDir } from '../../utils/path.ts'
import type { Fingerprint } from '../fingerprint/extract.ts'
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
 */
export async function rebuildCalibration(
  journalPath: string,
  calibrationPath: string,
): Promise<void> {
  let fileContent = ''
  try {
    fileContent = await fs.readFile(journalPath, 'utf8')
  } catch {
    // Journal file doesn't exist, clear calibration if it exists
    try {
      await fs.unlink(calibrationPath)
    } catch {}
    return
  }

  const lines = fileContent.split('\n')
  // biome-ignore lint/suspicious/noExplicitAny: parsed events mapping
  const sessionEventsMap = new Map<string, { events: any[]; firstTs: string }>()

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    try {
      const event = JSON.parse(trimmed)
      const sessionId = event.session_id || 'no-session'
      let sessionData = sessionEventsMap.get(sessionId)
      if (!sessionData) {
        sessionData = { events: [], firstTs: event.ts || new Date().toISOString() }
        sessionEventsMap.set(sessionId, sessionData)
      }
      sessionData.events.push(event)
    } catch {
      // Skip malformed lines
    }
  }

  const newRecords: CalibrationRecord[] = []

  for (const [sessionId, sessionData] of sessionEventsMap.entries()) {
    const events = sessionData.events
    if (events.length === 0) continue

    // 1. Gather fingerprints
    const fingerprints: Fingerprint[] = []
    for (const e of events) {
      if (e.kind === 'tool' && e.fingerprints) {
        fingerprints.push(...e.fingerprints)
      } else if (e.kind === 'verify' && e.fingerprints) {
        fingerprints.push(...e.fingerprints)
      }
    }

    // 2. Find fallback tool name
    const firstTool = events.find((e) => e.kind === 'tool')?.tool || 'unknown-tool'

    // 3. Compute bucket key
    const bKey = bucketKey(fingerprints, firstTool)

    // 4. Count verify attempts
    const verifyEvents = events.filter((e) => e.kind === 'verify')
    if (verifyEvents.length === 0) continue
    const attempt_count = verifyEvents.length

    // 5. Determine first-attempt success
    const first_attempt_success = verifyEvents[0]?.verdict === 'PASS'

    // 6. User modifications (permission denials)
    const user_modifications = events.filter(
      (e) => e.kind === 'permission' && e.decision === 'deny',
    ).length

    // 7. User reverts
    let user_reverts = events.filter((e) => e.kind === 'user' && e.cancel).length
    const hasUserCancelSession = events.some(
      (e) => e.kind === 'session' && e.exit_reason === 'user_cancel',
    )
    if (hasUserCancelSession) {
      user_reverts += 1
    }

    // 8. Resolved
    const resolved = events.some((e) => e.kind === 'session' && e.exit_reason === 'completed')

    // 9. Model ID
    const sessionEvent = events.find((e) => e.kind === 'session')
    const model_id = sessionEvent?.model || 'unknown-model'

    newRecords.push({
      session_id: sessionId,
      ts: sessionData.firstTs,
      bucket_key: bKey,
      model_id,
      attempt_count,
      first_attempt_success,
      user_modifications,
      user_reverts,
      resolved,
    })
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
    await fs.writeFile(calibrationPath, lines, 'utf8')
  }
}
