import type { JournalEvent } from '../events'
import { scoreEpisode } from './score.ts'
import type { Episode } from './types.ts'

export type StoredJournalEvent = JournalEvent & {
  ts: string
  session_id: string
}

export interface JournalEventWithLine {
  event: StoredJournalEvent
  line: number
}

function getToolSignature(event: Extract<StoredJournalEvent, { kind: 'tool' }>): string | null {
  if (event.fingerprints && event.fingerprints.length > 0) {
    return event.fingerprints[0]?.fine || null
  }
  return null
}

/**
 * Extracts unique signatures from a verify event.
 */
function getVerifySignatures(event: Extract<StoredJournalEvent, { kind: 'verify' }>): string[] {
  if (event.verdict === 'FAIL' || event.verdict === 'PARTIAL') {
    if (event.fingerprints && event.fingerprints.length > 0) {
      return event.fingerprints.map((fp: { fine?: string }) => fp.fine || '')
    }
  }
  return []
}

/**
 * Deterministic state machine that segments filtered journal events into episodes.
 */
export function segmentJournal(events: JournalEventWithLine[], startEpisodeIndex = 1): Episode[] {
  const episodes: Episode[] = []
  let nextIdIndex = startEpisodeIndex

  // Open episodes being tracked: signature -> partial Episode + active state
  interface ActiveEpisodeState {
    state: 'FAILING' | 'FIXING'
    session_id: string
    timestamp: string
    task_digest: string
    failure: {
      tool: string
      cmd: string // filled if we can detect the command
      error_class: string
      signature: string
    }
    fix?: {
      tool: string
      path: string
      summary: string
    }
    journal_line_range: {
      start: number
      end: number
    }
    repetitionCount: number
    hasPermissionDeny: boolean
  }

  const activeEpisodes = new Map<string, ActiveEpisodeState>()
  let lastUserDigest = ''
  let currentSessionId = 'no-session'

  // Helper to finalize an active episode and move it to the output list
  const finalizeEpisode = (
    signature: string,
    outcome: 'resolved' | 'abandoned',
    endLine: number,
    verification?: { cmd: string; exit_code: number },
  ) => {
    const active = activeEpisodes.get(signature)
    if (!active) return

    activeEpisodes.delete(signature)

    const partialEpisode: Omit<Episode, 'id' | 'value_score' | 'is_excluded' | 'exclusion_reason'> =
      {
        session_id: active.session_id,
        timestamp: active.timestamp,
        task_digest: active.task_digest,
        failure: active.failure,
        fix: active.fix,
        verification,
        outcome,
        journal_line_range: {
          start: active.journal_line_range.start,
          end: endLine,
        },
      }

    // Score and determine exclusions
    const episode = scoreEpisode(partialEpisode, nextIdIndex++, {
      hasPermissionDeny: active.hasPermissionDeny,
      repetitionCount: active.repetitionCount,
    })
    episodes.push(episode)
  }

  // Iterate chronologically through events
  for (let i = 0; i < events.length; i++) {
    const item = events[i]
    if (!item) continue
    const { event, line } = item

    if (event.session_id) {
      currentSessionId = event.session_id
    }

    if (event.kind === 'permission' && event.decision === 'deny') {
      for (const active of activeEpisodes.values()) {
        active.hasPermissionDeny = true
      }
    }

    if (event.kind === 'user') {
      lastUserDigest = event.digest

      // Pivot detection: If we see a new user input, look ahead to see if active failures reappear
      // If a signature does not appear in subsequent tool/verify runs for 3 turns, abandon it.
      for (const [signature, active] of activeEpisodes.entries()) {
        let signatureFoundAhead = false
        let turnCount = 0

        for (let j = i + 1; j < events.length; j++) {
          const aheadItem = events[j]
          if (!aheadItem) continue
          const ahead = aheadItem.event

          if (ahead.kind === 'turn') {
            turnCount++
            if (turnCount > 3) break
          }

          if (ahead.kind === 'tool') {
            const sig = getToolSignature(ahead)
            if (sig === signature) {
              signatureFoundAhead = true
              break
            }
          }

          if (ahead.kind === 'verify') {
            const sigs = getVerifySignatures(ahead)
            if (sigs.includes(signature)) {
              signatureFoundAhead = true
              break
            }
          }
        }

        if (!signatureFoundAhead) {
          finalizeEpisode(signature, 'abandoned', line)
        }
      }
      continue
    }

    if (event.kind === 'tool') {
      const signature = getToolSignature(event)

      if (signature) {
        // 1. Tool execution failed
        if (!activeEpisodes.has(signature)) {
          // WORKING -> FAILING
          activeEpisodes.set(signature, {
            state: 'FAILING',
            session_id: currentSessionId,
            timestamp: event.ts || new Date().toISOString(),
            task_digest: lastUserDigest,
            failure: {
              tool: event.tool,
              cmd: event.cmd || '',
              error_class:
                event.error_class ||
                (event.fingerprints && event.fingerprints.length > 0
                  ? event.fingerprints[0]?.coarse.split('|')[1]
                  : null) ||
                'Error',
              signature,
            },
            journal_line_range: {
              start: line,
              end: line,
            },
            repetitionCount: 1,
            hasPermissionDeny: false,
          })
        } else {
          // If already FAILING/FIXING and we fail again, remain in active failure state
          const active = activeEpisodes.get(signature)
          if (active) {
            active.journal_line_range.end = line
            active.repetitionCount++
          }
        }
      } else if (event.outcome === 'success' && (event.tool === 'Edit' || event.tool === 'Write')) {
        // 2. Success edit tool: FAILING -> FIXING
        const editPath = event.path
        if (editPath) {
          for (const [sig, active] of activeEpisodes.entries()) {
            if (active.state === 'FAILING' && sig.includes(editPath)) {
              active.state = 'FIXING'
              active.fix = {
                tool: event.tool,
                path: editPath,
                summary: `Successful ${event.tool} on ${editPath}`,
              }
              active.journal_line_range.end = line
            }
          }
        }
      } else if (event.outcome === 'success' && event.tool === 'Bash') {
        // 3. Successful Bash run: FIXING -> RESOLVED (treat it as verification pass fallback)
        // If a Bash tool succeeds, has no fingerprints, and its exit code is actually 0,
        // it could resolve active episodes.
        if (event.exit_code === 0) {
          for (const [sig, active] of activeEpisodes.entries()) {
            if (active.state === 'FIXING') {
              finalizeEpisode(sig, 'resolved', line, {
                cmd: event.cmd || '',
                exit_code: 0,
              })
            }
          }
        }
      }
    }

    if (event.kind === 'verify') {
      const activeSignatures = getVerifySignatures(event)

      if (event.verdict === 'PASS') {
        // Transition all active episodes to RESOLVED
        for (const signature of activeEpisodes.keys()) {
          finalizeEpisode(signature, 'resolved', line, {
            cmd: event.command,
            exit_code: event.exit_code,
          })
        }
      } else {
        // FAIL or PARTIAL
        for (const [signature, active] of activeEpisodes.entries()) {
          if (!activeSignatures.includes(signature)) {
            // Fingerprint is gone: transition to RESOLVED
            finalizeEpisode(signature, 'resolved', line, {
              cmd: event.command,
              exit_code: event.exit_code,
            })
          } else if (active.state === 'FIXING') {
            // Fingerprint still present: revert FIXING -> FAILING
            active.state = 'FAILING'
            active.journal_line_range.end = line
          }
        }
      }
    }
  }

  // Session end: All remaining open episodes are ABANDONED
  const lastLine = events.length > 0 ? events[events.length - 1]?.line || 1 : 1
  for (const signature of activeEpisodes.keys()) {
    finalizeEpisode(signature, 'abandoned', lastLine)
  }

  return episodes
}
