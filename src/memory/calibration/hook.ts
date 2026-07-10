import fs from 'node:fs/promises'
import path from 'node:path'
import { getResolvedModel } from '../../providers/index.ts'
import { getMemoryDir } from '../../utils/path.ts'
import { isKnownJournalEvent, parseJournalEvent } from '../events.ts'
import type { Fingerprint } from '../fingerprint/extract.ts'
import { bucketKey } from './bucket.ts'
import {
  type CalibrationRecord,
  appendCalibrationRecords,
  readCalibrationRecords,
} from './stats.ts'

/**
 * Session-end hook that aggregates metrics for the completed session,
 * maps them to a task bucket, and appends a calibration record.
 * Enforces a 5-second timeout and is idempotent per session/bucket.
 *
 * @param sessionId The active session ID to analyze.
 * @param memoryDir Optional custom memory directory path.
 */
export async function runSessionEndCalibration(
  sessionId: string,
  memoryDir?: string,
): Promise<void> {
  let timeoutId: NodeJS.Timeout | null = null

  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Session end calibration hook timed out'))
    }, 5000)
  })

  const workPromise = (async () => {
    try {
      const resolvedMemoryDir = memoryDir ?? getMemoryDir()
      const journalPath = path.join(resolvedMemoryDir, 'journal.jsonl')
      const calibrationPath = path.join(resolvedMemoryDir, 'calibration.jsonl')

      let fileContent = ''
      try {
        fileContent = await fs.readFile(journalPath, 'utf8')
      } catch {
        // Journal file doesn't exist, nothing to calibrate
        return
      }

      const lines = fileContent.split('\n')
      // biome-ignore lint/suspicious/noExplicitAny: parsed events mapping
      const events: any[] = []

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = parseJournalEvent(JSON.parse(trimmed))
          if (!parsed || !isKnownJournalEvent(parsed)) continue
          if (parsed.session_id === sessionId) {
            events.push(parsed)
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (events.length === 0) {
        return
      }

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

      // 4. Check for duplicate to remain idempotent
      const existingRecords = await readCalibrationRecords(calibrationPath)
      const alreadyExists = existingRecords.some(
        (r) => r.session_id === sessionId && r.bucket_key === bKey,
      )
      if (alreadyExists) {
        return
      }

      // 5. Count verify attempts
      const verifyEvents = events.filter((e) => e.kind === 'verify')
      if (verifyEvents.length === 0) {
        return
      }
      const attempt_count = verifyEvents.length

      // 6. Determine first-attempt success
      const first_attempt_success = verifyEvents[0]?.verdict === 'PASS'

      // 7. User modifications (permission denials)
      const user_modifications = events.filter(
        (e) => e.kind === 'permission' && e.decision === 'deny',
      ).length

      // 8. User reverts
      let user_reverts = events.filter((e) => e.kind === 'user' && e.cancel).length
      const hasUserCancelSession = events.some(
        (e) => e.kind === 'session' && e.exit_reason === 'user_cancel',
      )
      if (hasUserCancelSession) {
        user_reverts += 1
      }

      // 9. Resolved
      const resolved = events.some((e) => e.kind === 'session' && e.exit_reason === 'completed')

      // 10. Model ID
      const sessionEvent = events.find((e) => e.kind === 'session')
      const model_id = sessionEvent?.model || getResolvedModel()

      // Obtain first event timestamp or fallback
      const ts = events[0]?.ts || new Date().toISOString()

      const record: CalibrationRecord = {
        session_id: sessionId,
        ts,
        bucket_key: bKey,
        model_id,
        attempt_count,
        first_attempt_success,
        user_modifications,
        user_reverts,
        resolved,
      }

      await appendCalibrationRecords([record], calibrationPath)
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  })()

  await Promise.race([workPromise, timeoutPromise])
}
