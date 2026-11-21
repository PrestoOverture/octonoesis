import fs from 'node:fs/promises'
import path from 'node:path'
import { structuredPatch } from 'diff'
import type { RuleFile } from '../memory/rules/types'
import { type FileHistory, readFileSnapshot } from '../state/fileHistory'
import type { CheckpointTimeline, FileChange, RuleSummary } from './protocol'

/** Larger files are listed without a patch; the panel is a review aid, not a diff tool. */
const PATCH_LIMIT = 512 * 1024

export function checkpointTimeline(history: FileHistory | undefined): CheckpointTimeline {
  return {
    entries: (history?.entries ?? []).map(({ seq, ts, tool, path, snapshot }) => ({
      seq,
      ts,
      tool,
      path,
      created: snapshot === 'absent',
    })),
    commands: history?.commands ?? [],
  }
}

/** Current bytes, or undefined when deleted; `null` when a symlink now leads outside the repo. */
async function current(root: string, file: string): Promise<Buffer | undefined | null> {
  try {
    const real = await fs.realpath(file)
    if (!real.startsWith(root + path.sep)) return null
    return await fs.readFile(real)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const binary = (content: Buffer | undefined) => !!content?.includes(0)

/**
 * Each file the session's Write/Edit calls touched: its state before the first change
 * against what is on disk now. Shell commands are not checkpointed, so their effects
 * appear only when they changed one of these files.
 */
export async function sessionChanges(
  memoryDir: string,
  sessionId: string,
  history: FileHistory | undefined,
): Promise<FileChange[]> {
  if (!history) return []
  const first = new Map<string, string>()
  for (const entry of history.entries)
    if (!first.has(entry.path)) first.set(entry.path, entry.snapshot)
  const changes: FileChange[] = []
  for (const [relative, snapshot] of first) {
    const target = path.resolve(history.repoRoot, relative)
    // Recorded paths are repo-relative; refuse anything a tampered manifest points elsewhere.
    if (!target.startsWith(history.repoRoot + path.sep)) continue
    const before = await readFileSnapshot(memoryDir, sessionId, snapshot)
    const after = await current(history.repoRoot, target)
    if (after === null) continue
    if (before === undefined && after === undefined) continue
    if (before && after && before.equals(after)) continue
    const status = before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified'
    if (binary(before) || binary(after)) {
      changes.push({ path: relative, status, added: 0, removed: 0, note: 'binary' })
      continue
    }
    if ((before?.length ?? 0) > PATCH_LIMIT || (after?.length ?? 0) > PATCH_LIMIT) {
      changes.push({ path: relative, status, added: 0, removed: 0, note: 'too_large' })
      continue
    }
    const patch = structuredPatch(
      relative,
      relative,
      before?.toString('utf8') ?? '',
      after?.toString('utf8') ?? '',
      '',
      '',
      { context: 3 },
    )
    const lines = patch.hunks.flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines,
    ])
    changes.push({
      path: relative,
      status,
      added: lines.filter((line) => line.startsWith('+')).length,
      removed: lines.filter((line) => line.startsWith('-')).length,
      patch: lines.join('\n'),
    })
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path))
}

const ADVICE_LIMIT = 400

/** The repository's rule pool as the Learning panel lists it, strongest first. */
export function ruleSummaries(rules: RuleFile[]): RuleSummary[] {
  return rules
    .map(({ id, status, confidence, hits, misses, scope, advice }) => ({
      id,
      status,
      confidence,
      hits,
      misses,
      scope,
      advice: advice.length > ADVICE_LIMIT ? `${advice.slice(0, ADVICE_LIMIT - 1)}…` : advice,
    }))
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
}
