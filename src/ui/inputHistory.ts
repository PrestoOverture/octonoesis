import fs from 'node:fs/promises'
import path from 'node:path'

export interface InputHistoryEntry {
  ts: string
  text: string
}

export interface AppendInputHistoryOptions {
  now?: Date
}

export interface InputHistoryCursor {
  index: number | null
  draft: string
}

export interface InputHistoryNavigation {
  value: string
  cursor: InputHistoryCursor
}

const LOAD_LIMIT = 500
const TRUNCATE_THRESHOLD = 1_000
const appendQueues = new Map<string, Promise<void>>()

/**
 * Resolves the path to the input history JSONL file inside the given memory directory.
 *
 * @param memoryDir - Path to persistent memory directory
 * @returns Absolute or relative path to `input_history.jsonl`
 */
export function getInputHistoryPath(memoryDir: string): string {
  return path.join(memoryDir, 'input_history.jsonl')
}

/**
 * Creates an empty input history navigation cursor.
 *
 * @returns Fresh InputHistoryCursor pointing to no history entry with an empty draft
 */
export function createInputHistoryCursor(): InputHistoryCursor {
  return { index: null, draft: '' }
}

/**
 * Navigates through historical input entries, preserving in-progress draft text.
 *
 * Only single-line inputs participate in history navigation; multiline inputs return the current value.
 *
 * @param entries - Array of historical prompt strings (oldest to newest)
 * @param cursor - Current history cursor
 * @param direction - Direction to move ('older' or 'newer')
 * @param currentValue - Current prompt input value
 * @returns Navigation result with updated prompt value and cursor position
 */
export function navigateInputHistory(
  entries: string[],
  cursor: InputHistoryCursor,
  direction: 'older' | 'newer',
  currentValue: string,
): InputHistoryNavigation {
  if (currentValue.includes('\n') || entries.length === 0) {
    return { value: currentValue, cursor }
  }
  if (direction === 'older') {
    const index = cursor.index === null ? entries.length - 1 : Math.max(0, cursor.index - 1)
    return {
      value: entries[index] ?? currentValue,
      cursor: {
        index,
        draft: cursor.index === null ? currentValue : cursor.draft,
      },
    }
  }
  if (cursor.index === null) return { value: currentValue, cursor }
  if (cursor.index < entries.length - 1) {
    const index = cursor.index + 1
    return { value: entries[index] ?? currentValue, cursor: { ...cursor, index } }
  }
  return { value: cursor.draft, cursor: createInputHistoryCursor() }
}

/**
 * Parses JSONL content into an array of valid input history entries, discarding corrupt lines.
 *
 * @param content - Raw JSONL file content
 * @returns Array of valid history entries
 */
function parseEntries(content: string): InputHistoryEntry[] {
  const entries: InputHistoryEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as { ts?: unknown; text?: unknown }
      if (typeof parsed.ts === 'string' && typeof parsed.text === 'string') {
        entries.push({ ts: parsed.ts, text: parsed.text })
      }
    } catch {
      // Invalid historical rows are ignored; later valid rows remain usable.
    }
  }
  return entries
}

/**
 * Reads the raw input history file, returning empty string if the file does not exist.
 *
 * @param memoryDir - Memory directory containing input history
 * @returns Raw file text or empty string if missing
 * @throws If read fails for reasons other than ENOENT
 */
async function readHistoryFile(memoryDir: string): Promise<string> {
  try {
    return await fs.readFile(getInputHistoryPath(memoryDir), 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Loads the most recent input history entries from disk.
 *
 * @param memoryDir - Memory directory containing input history
 * @param limit - Maximum number of entries to return (defaults to 500)
 * @returns Array of loaded history entries ordered chronologically
 */
export async function loadInputHistory(
  memoryDir: string,
  limit = LOAD_LIMIT,
): Promise<InputHistoryEntry[]> {
  const entries = parseEntries(await readHistoryFile(memoryDir))
  return entries.slice(-Math.max(0, limit))
}

/**
 * Appends a history entry without concurrency locking, truncating when exceeding threshold.
 *
 * @param memoryDir - Memory directory
 * @param text - Prompt text to record
 * @param options - Append options such as timestamp override
 * @returns Promise resolving when write completes
 */
async function appendInputHistoryUnlocked(
  memoryDir: string,
  text: string,
  options: AppendInputHistoryOptions = {},
): Promise<void> {
  const existing = parseEntries(await readHistoryFile(memoryDir))
  if (existing[existing.length - 1]?.text === text) return
  await fs.mkdir(memoryDir, { recursive: true })
  const entry: InputHistoryEntry = {
    ts: (options.now ?? new Date()).toISOString(),
    text,
  }
  const nextEntries = [...existing, entry]
  if (nextEntries.length > TRUNCATE_THRESHOLD) {
    const retained = nextEntries.slice(-LOAD_LIMIT)
    await fs.writeFile(
      getInputHistoryPath(memoryDir),
      `${retained.map((value) => JSON.stringify(value)).join('\n')}\n`,
      'utf8',
    )
    return
  }
  await fs.appendFile(getInputHistoryPath(memoryDir), `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * Appends a user prompt to input history with serialized per-file concurrency queuing.
 *
 * Deduplicates consecutive identical entries and truncates the file if it exceeds the threshold.
 *
 * @param memoryDir - Memory directory path
 * @param text - Prompt text to persist
 * @param options - Append options such as timestamp override
 * @returns Promise resolving when the append operation finishes
 */
export async function appendInputHistory(
  memoryDir: string,
  text: string,
  options: AppendInputHistoryOptions = {},
): Promise<void> {
  const historyPath = getInputHistoryPath(memoryDir)
  const previous = appendQueues.get(historyPath) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(() => appendInputHistoryUnlocked(memoryDir, text, options))
  appendQueues.set(historyPath, operation)
  try {
    await operation
  } finally {
    if (appendQueues.get(historyPath) === operation) appendQueues.delete(historyPath)
  }
}
