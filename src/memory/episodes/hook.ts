import fs from 'node:fs/promises'
import path from 'node:path'
import { getMemoryDir } from '../../utils/path'
import { isKnownJournalEvent, parseJournalEvent } from '../events'
import { type JournalEventWithLine, type StoredJournalEvent, segmentJournal } from './segment'
import { readEpisodes } from './store'
import type { Episode } from './types'

/**
 * Checks if two episodes are equal (ignoring the ID and value_score).
 * @param ep1 The first episode to compare.
 * @param ep2 The second episode to compare.
 * @returns True if the episodes are equal, false otherwise.
 */
function isEpisodeEqual(ep1: Episode, ep2: Episode): boolean {
  if (ep1.outcome !== ep2.outcome) return false
  if (ep1.value_score !== ep2.value_score) return false
  if (ep1.is_excluded !== ep2.is_excluded) return false
  if (ep1.exclusion_reason !== ep2.exclusion_reason) return false
  if (ep1.journal_line_range.start !== ep2.journal_line_range.start) return false
  if (ep1.journal_line_range.end !== ep2.journal_line_range.end) return false

  // Compare attribution
  if (ep1.attribution.status !== ep2.attribution.status) return false
  if (ep1.attribution.primary !== ep2.attribution.primary) return false
  if (ep1.attribution.confidence !== ep2.attribution.confidence) return false

  // Compare fix_candidates
  if (ep1.fix_candidates.length !== ep2.fix_candidates.length) return false
  for (let i = 0; i < ep1.fix_candidates.length; i++) {
    const c1 = ep1.fix_candidates[i]
    const c2 = ep2.fix_candidates[i]
    if (!c1 || !c2) return false
    if (c1.tool !== c2.tool) return false
    if (c1.path !== c2.path) return false
    if (c1.summary !== c2.summary) return false
    if (c1.role !== c2.role) return false
  }

  // Compare verification
  if (ep1.verification || ep2.verification) {
    if (!ep1.verification || !ep2.verification) return false
    if (ep1.verification.cmd !== ep2.verification.cmd) return false
    if (ep1.verification.exit_code !== ep2.verification.exit_code) return false
  }

  return true
}

/**
 * Session-end hook that reads the journal log, extracts this session's events,
 * segments them into episodes, and appends new or updated episodes to episodes.jsonl.
 * Enforces a 5-second timeout.
 * @param sessionId The active session ID.
 * @param memoryDir Optional custom memory directory path.
 */
export async function runSessionEndEpisodes(sessionId: string, memoryDir?: string): Promise<void> {
  let timeoutId: NodeJS.Timeout | null = null

  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Session end episode segmentation hook timed out'))
    }, 5000)
  })

  const workPromise = (async () => {
    try {
      const resolvedMemoryDir = memoryDir ?? getMemoryDir()
      const journalPath = path.join(resolvedMemoryDir, 'journal.jsonl')
      const episodesPath = path.join(resolvedMemoryDir, 'episodes.jsonl')

      let fileContent = ''
      try {
        fileContent = await fs.readFile(journalPath, 'utf8')
      } catch {
        // Journal file doesn't exist, no episodes to process
        return
      }

      const lines = fileContent.split('\n')
      const eventsWithLines: JournalEventWithLine[] = []

      for (let i = 0; i < lines.length; i++) {
        const lineStr = lines[i]?.trim()
        if (!lineStr) continue

        try {
          const parsed = parseJournalEvent(JSON.parse(lineStr))
          if (!parsed || !isKnownJournalEvent(parsed)) continue
          eventsWithLines.push({
            event: parsed as StoredJournalEvent,
            line: i + 1,
          })
        } catch {
          // Skip malformed lines
        }
      }

      // Read existing unique episodes from disk
      const allEpisodes = await readEpisodes(episodesPath)

      // Filter events belonging to the current session
      const sessionEvents = eventsWithLines.filter((item) => item.event.session_id === sessionId)
      if (sessionEvents.length === 0) {
        return
      }

      // Determine the next sequential index based on the highest existing index in allEpisodes.
      let nextIdx = 1
      if (allEpisodes.length > 0) {
        const lastEpisode = allEpisodes[allEpisodes.length - 1]
        if (lastEpisode?.id) {
          const match = lastEpisode.id.match(/^ep_(\d+)$/)
          if (match?.[1]) {
            nextIdx = Number.parseInt(match[1], 10) + 1
          } else {
            nextIdx = allEpisodes.length + 1
          }
        }
      }

      // Run segmenter (passing a temporary starting index)
      const segmentedEpisodes = segmentJournal(sessionEvents, 9999)

      // Map segmented episodes to existing ones, or assign new sequential IDs.
      const episodesToAppend: Episode[] = []
      const identityToExisting = new Map<string, Episode>()
      for (const ep of allEpisodes) {
        const key = `${ep.session_id}|${ep.journal_line_range.start}`
        identityToExisting.set(key, ep)
      }

      for (const newEp of segmentedEpisodes) {
        const key = `${newEp.session_id}|${newEp.journal_line_range.start}`
        const existing = identityToExisting.get(key)

        if (existing) {
          // Reuse original ID
          newEp.id = existing.id
          // Only append if it has changed (e.g. outcome transitioned from abandoned to resolved)
          if (!isEpisodeEqual(existing, newEp)) {
            episodesToAppend.push(newEp)
          }
        } else {
          // Assign new sequential ID
          newEp.id = `ep_${String(nextIdx++).padStart(4, '0')}`
          episodesToAppend.push(newEp)
        }
      }

      // Append new or updated episodes to the file
      if (episodesToAppend.length > 0) {
        await fs.mkdir(resolvedMemoryDir, { recursive: true })
        const lines = episodesToAppend.map((ep) => `${JSON.stringify(ep)}\n`).join('')
        await fs.appendFile(episodesPath, lines, 'utf8')
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  })()

  await Promise.race([workPromise, timeoutPromise])
}
