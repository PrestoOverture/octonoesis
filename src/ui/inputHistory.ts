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

export function getInputHistoryPath(memoryDir: string): string {
  return path.join(memoryDir, 'input_history.jsonl')
}

export function createInputHistoryCursor(): InputHistoryCursor {
  return { index: null, draft: '' }
}

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

async function readHistoryFile(memoryDir: string): Promise<string> {
  try {
    return await fs.readFile(getInputHistoryPath(memoryDir), 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return ''
    throw error
  }
}

export async function loadInputHistory(
  memoryDir: string,
  limit = LOAD_LIMIT,
): Promise<InputHistoryEntry[]> {
  const entries = parseEntries(await readHistoryFile(memoryDir))
  return entries.slice(-Math.max(0, limit))
}

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
