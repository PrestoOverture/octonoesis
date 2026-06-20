import type { JournalEvent } from '../events'
import { scoreEpisode } from './score.ts'
import type { AttributionStatus, Episode, FixCandidate } from './types.ts'

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
 * Checks if two repository-relative file paths are in the same parent directory.
 */
function isSameParentDirectory(pathA: string, pathB: string): boolean {
  if (!pathA || !pathB) return false
  const getParentDir = (p: string) => {
    const lastSlash = p.lastIndexOf('/')
    return lastSlash === -1 ? '' : p.slice(0, lastSlash)
  }
  return getParentDir(pathA) === getParentDir(pathB)
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
      file?: string
    }
    candidates: {
      tool: string
      path: string
      summary: string
      input_digest?: string
    }[]
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

    // Build the candidates with roles
    let errorFile = active.failure.file || ''
    if (!errorFile && active.failure.signature) {
      const parts = active.failure.signature.split('|')
      if (parts.length >= 3) {
        errorFile = parts[2] || ''
      }
    }
    const fix_candidates: FixCandidate[] = active.candidates.map((c) => {
      let role: 'direct' | 'related' | 'indirect' = 'indirect'
      if (errorFile) {
        if (c.path === errorFile) {
          role = 'direct'
        } else if (isSameParentDirectory(c.path, errorFile)) {
          role = 'related'
        }
      }
      return {
        tool: c.tool,
        path: c.path,
        summary: c.summary,
        role,
      }
    })

    // Compute attribution
    let status: AttributionStatus = 'unattributable'
    let primary: string | undefined = undefined
    let confidence = 0.1

    if (fix_candidates.length > 0) {
      const directs = fix_candidates.filter((c) => c.role === 'direct')
      const relateds = fix_candidates.filter((c) => c.role === 'related')

      if (directs.length > 0) {
        primary = directs[0]?.path
        if (fix_candidates.length === 1) {
          status = 'single_direct'
          confidence = 0.9
        } else {
          status = 'multi_with_direct'
          confidence = 0.7
        }
      } else {
        status = 'indirect_only'
        primary = relateds[0]?.path || fix_candidates[0]?.path
        confidence = 0.4
      }
    }

    const partialEpisode: Omit<Episode, 'id' | 'value_score' | 'is_excluded' | 'exclusion_reason'> =
      {
        session_id: active.session_id,
        timestamp: active.timestamp,
        task_digest: active.task_digest,
        failure: {
          tool: active.failure.tool,
          cmd: active.failure.cmd,
          error_class: active.failure.error_class,
          signature: active.failure.signature,
        },
        fix_candidates,
        attribution: {
          status,
          primary,
          confidence,
        },
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
          const fp = event.fingerprints?.[0]
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
              file: fp?.file || '',
            },
            candidates: [],
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
          for (const active of activeEpisodes.values()) {
            if (active.state === 'FAILING' || active.state === 'FIXING') {
              active.state = 'FIXING'

              const alreadyExists = active.candidates.some(
                (c) => c.path === editPath && c.input_digest === event.input_digest,
              )
              if (!alreadyExists) {
                active.candidates.push({
                  tool: event.tool,
                  path: editPath,
                  summary: `Successful ${event.tool} on ${editPath}`,
                  input_digest: event.input_digest,
                })
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
