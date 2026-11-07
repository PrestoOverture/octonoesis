import type { Checkpoint, CheckpointTimeline } from '../../../src/host/protocol'

export type TimelineRow =
  | { kind: 'change'; entry: Checkpoint }
  | { kind: 'command'; afterSeq: number; ts: string; command: string }

/** Newest first; each shell command sits right above the checkpoint it followed. */
export function timelineRows(timeline: CheckpointTimeline): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (let seq = 0; seq <= timeline.entries.length; seq++) {
    const entry = timeline.entries[seq - 1]
    if (entry) rows.push({ kind: 'change', entry })
    for (const command of timeline.commands)
      if (command.afterSeq === seq) rows.push({ kind: 'command', ...command })
  }
  return rows.reverse()
}

/**
 * What rewinding to before `seq` does, mirroring `planFileRestore`: one action per file
 * changed at or after it, decided by that file's earliest change in the range.
 */
export function rewindPlan(timeline: CheckpointTimeline, seq: number) {
  const files = new Map<string, 'restore' | 'delete'>()
  for (const entry of timeline.entries)
    if (entry.seq >= seq && !files.has(entry.path))
      files.set(entry.path, entry.created ? 'delete' : 'restore')
  return {
    files: [...files].map(([path, action]) => ({ path, action })),
    // As in `octonoesis rewind`: commands from just before the change onward are not undone.
    commands: timeline.commands
      .filter((command) => command.afterSeq >= seq - 1)
      .map((command) => command.command),
  }
}
