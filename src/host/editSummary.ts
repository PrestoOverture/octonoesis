import { diffLines } from 'diff'

/** Count changed lines only, excluding context shared by the two Edit strings. */
export function editLineCounts(oldText: string, newText: string) {
  let added = 0
  let removed = 0
  for (const part of diffLines(oldText, newText)) {
    if (part.added) added += part.count ?? 0
    if (part.removed) removed += part.count ?? 0
  }
  return { added, removed }
}
