import fs from 'node:fs/promises'
import path from 'node:path'
import { appendJsonl } from '../utils/appendJsonl'
import { dbg } from '../utils/debug'
import { getMemoryDir } from '../utils/path'
import { EVENT_SCHEMA_VERSIONS, type JournalEvent } from './events'

let activeSessionId: string | null = null
let writeQueue: Promise<void> = Promise.resolve()
let journalWriteFailureCount = 0
let lastJournalWriteFailureCode: string | undefined

/**
 * Returns the number of journal writes that failed in this process.
 * @returns The process-level journal write failure count.
 */
export function getJournalWriteFailureCount(): number {
  return journalWriteFailureCount
}

/**
 * Resets the journal failure count and last error code for tests.
 */
export function resetJournalWriteFailures(): void {
  journalWriteFailureCount = 0
  lastJournalWriteFailureCode = undefined
}

/**
 * Formats a one-line notice of journal writes lost in this process.
 * @returns The failure notice, or undefined when no writes failed.
 */
export function formatJournalFailureNotice(): string | undefined {
  if (journalWriteFailureCount === 0) return undefined
  return `⚠ Ledger incomplete: ${journalWriteFailureCount} journal write(s) failed this session (last: ${lastJournalWriteFailureCode})`
}

/**
 * Binds the active session ID to attach to upcoming journal events.
 * @param id The active session ID.
 */
export function setSessionId(id: string): void {
  activeSessionId = id
}

/**
 * Returns the currently active session ID.
 * @returns The currently active session ID or null if not set.
 */
export function getSessionId(): string | null {
  return activeSessionId
}

// Distributive Omit preserves discriminated union kind structure in TS compiler
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * Appends a journal event to the log file asynchronously and in order.
 * @param event The journal event payload (omits metadata ts/session_id but allows optional overrides).
 */
export function appendJournal(
  event: DistributiveOmit<JournalEvent, 'ts' | 'session_id'> & { ts?: string; session_id?: string },
): void {
  const ts = event.ts || new Date().toISOString()
  const session_id = event.session_id || activeSessionId || 'no-session'
  const schema_version = event.schema_version ?? EVENT_SCHEMA_VERSIONS[event.kind]
  const fullEvent = { ts, session_id, ...event, schema_version }

  const line = `${JSON.stringify(fullEvent)}\n`

  // Capture target directory and path synchronously at call time to prevent environment variables leaking across async tests
  const memoryDir = getMemoryDir()
  const journalPath = path.join(memoryDir, 'journal.jsonl')

  // Queue to preserve chronological append order on disk
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.mkdir(memoryDir, { recursive: true })
      await appendJsonl(journalPath, line)
    } catch (err) {
      journalWriteFailureCount++
      lastJournalWriteFailureCode =
        typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'UNKNOWN'
      const warning = `⚠ Journal write failed: ${journalPath} (${lastJournalWriteFailureCode})`
      if (journalWriteFailureCount === 1) console.error(warning)
      else dbg('journal', warning)
    }
  })
}

/**
 * Flushes all pending writes to ensure the file is complete.
 */
export async function flushJournal(): Promise<void> {
  await writeQueue
}
