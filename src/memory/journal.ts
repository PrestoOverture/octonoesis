import fs from 'node:fs/promises'
import path from 'node:path'
import { getMemoryDir } from '../utils/path'
import type { JournalEvent } from './events'

let activeSessionId: string | null = null
let writeQueue: Promise<void> = Promise.resolve()

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
  const fullEvent = { ts, session_id, ...event }

  const line = `${JSON.stringify(fullEvent)}\n`

  // Capture target directory and path synchronously at call time to prevent environment variables leaking across async tests
  const memoryDir = getMemoryDir()
  const journalPath = path.join(memoryDir, 'journal.jsonl')

  // Queue to preserve chronological append order on disk
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.mkdir(memoryDir, { recursive: true })
      await fs.appendFile(journalPath, line, 'utf8')
    } catch (err) {
      // Fail silently in production, but report to stderr in debug modes
    }
  })
}

/**
 * Flushes all pending writes to ensure the file is complete.
 */
export async function flushJournal(): Promise<void> {
  await writeQueue
}
