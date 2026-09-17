import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getMemoryDir } from '../../utils/path'
import { appendJournal } from '../journal'
import { type MemoryFile, type MemoryWrite, memoryFileSchema, memoryWritesSchema } from './types'

const MEMORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const MEMORY_INDEX_MAX_LINES = 200
const MEMORY_INDEX_MAX_BYTES = 25 * 1024

/**
 * Returns the filesystem directory path where individual memory files and the MEMORY.md index reside.
 *
 * @returns Path to the auto-memory directory.
 */
export function getAutoMemoryDir(): string {
  return path.join(getMemoryDir(), 'memory')
}

/**
 * Serializes a string as a JSON-escaped string for YAML frontmatter compatibility.
 *
 * @param value - Raw string.
 * @returns JSON-quoted escaped string.
 */
function serializeScalar(value: string): string {
  return JSON.stringify(value)
}

/**
 * Parses a YAML scalar value, unquoting JSON strings if double-quoted.
 *
 * @param value - Scalar string.
 * @returns Unquoted string value.
 * @throws TypeError If parsed JSON value is not a string.
 */
function parseScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'string') throw new TypeError('Memory frontmatter value must be a string')
    return parsed
  }
  return trimmed
}

/**
 * Serializes a MemoryFile into a Markdown document with YAML frontmatter.
 *
 * @param memory - MemoryFile to serialize.
 * @returns Serialized Markdown string with frontmatter.
 */
export function serializeMemory(memory: MemoryFile): string {
  return [
    '---',
    `name: ${serializeScalar(memory.name)}`,
    `description: ${serializeScalar(memory.description)}`,
    `type: ${memory.type}`,
    '---',
    memory.content,
  ].join('\n')
}

/**
 * Parses a Markdown document with YAML frontmatter into a validated MemoryFile record.
 *
 * @param content - File content string.
 * @param filePath - Path to the file.
 * @param mtime - File modification timestamp in milliseconds.
 * @returns Validated MemoryFile object.
 * @throws TypeError If frontmatter is missing or invalid.
 */
export function parseMemory(content: string, filePath: string, mtime: number): MemoryFile {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/)
  if (!match?.[1] || match[2] === undefined) {
    throw new TypeError('Invalid memory file: missing YAML frontmatter')
  }

  const frontmatter = new Map<string, string>()
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 1) continue
    frontmatter.set(line.slice(0, colon).trim(), parseScalar(line.slice(colon + 1)))
  }

  return memoryFileSchema.parse({
    name: frontmatter.get('name'),
    description: frontmatter.get('description'),
    type: frontmatter.get('type'),
    content: match[2],
    path: filePath,
    mtime,
  })
}

/**
 * Checks whether an error is a filesystem file-not-found (ENOENT) error.
 *
 * @param error - The caught error.
 * @returns True if error has ENOENT code; otherwise false.
 */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Truncates content to at most `maxBytes` from the tail, preserving valid UTF-8 character boundaries.
 *
 * @param content - Raw text content.
 * @param maxBytes - Maximum byte length.
 * @returns Sliced tail string.
 */
function tailByBytes(content: string, maxBytes: number): string {
  const buffer = Buffer.from(content)
  if (buffer.length <= maxBytes) return content

  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] ?? 0) >> 6 === 2) start++
  return buffer.subarray(start).toString('utf8')
}

/**
 * Caps memory index content to at most 200 lines and 25KB bytes from the tail.
 *
 * @param content - Raw index file text.
 * @returns Capped index text.
 */
function capMemoryIndex(content: string): string {
  const lines = content.split(/\r?\n/)
  const lineCapped = lines.slice(-MEMORY_INDEX_MAX_LINES).join('\n')
  return tailByBytes(lineCapped, MEMORY_INDEX_MAX_BYTES)
}

/**
 * Loads and caps the `MEMORY.md` index file, returning an empty string if it does not exist.
 *
 * @returns Promise resolving to the index string.
 * @throws Error If file read fails for a reason other than ENOENT.
 */
export async function loadMemoryIndex(): Promise<string> {
  try {
    const content = await fs.readFile(path.join(getAutoMemoryDir(), 'MEMORY.md'), 'utf8')
    return capMemoryIndex(content)
  } catch (error) {
    if (isMissingFile(error)) return ''
    throw error
  }
}

/**
 * Reads and parses all valid `.md` memory files from the auto-memory directory.
 *
 * @returns Promise resolving to an array of parsed MemoryFile objects.
 * @throws Error If reading directory fails with an error other than ENOENT.
 */
export async function loadMemories(): Promise<MemoryFile[]> {
  const memoryDir = getAutoMemoryDir()
  let entries: Dirent<string>[]
  try {
    entries = await fs.readdir(memoryDir, { withFileTypes: true })
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }

  const memoryPaths = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name !== 'MEMORY.md' &&
        entry.name.endsWith('.md') &&
        MEMORY_NAME_PATTERN.test(entry.name.slice(0, -3)),
    )
    .map((entry) => path.join(memoryDir, entry.name))
    .sort()

  return Promise.all(
    memoryPaths.map(async (memoryPath) => {
      const [content, stats] = await Promise.all([
        fs.readFile(memoryPath, 'utf8'),
        fs.stat(memoryPath),
      ])
      return parseMemory(content, memoryPath, stats.mtimeMs)
    }),
  )
}

/**
 * Validates that a memory file name matches the allowed kebab-case slug pattern (`^[a-z0-9][a-z0-9-]*$`).
 *
 * @param name - Memory file name to check.
 * @throws TypeError If the name format is invalid.
 */
function assertSafeMemoryName(name: string): void {
  if (!MEMORY_NAME_PATTERN.test(name)) {
    throw new TypeError(`Invalid memory name: ${name}`)
  }
}

/**
 * Re-reads all memory files from disk and rewrites `MEMORY.md` with an updated Markdown link index.
 */
async function regenerateMemoryIndex(): Promise<void> {
  const memories = await loadMemories()
  const index = memories
    .map((memory) => `- [${memory.name}](${memory.name}.md) — ${memory.description}`)
    .join('\n')
  await fs.writeFile(path.join(getAutoMemoryDir(), 'MEMORY.md'), index, 'utf8')
}

/**
 * Applies a list of memory operations ('create', 'update', 'delete') to disk, logs journal events,
 * and regenerates `MEMORY.md`.
 *
 * @param writes - Array of memory writes to validate and persist.
 */
export async function applyMemoryWrites(writes: MemoryWrite[]): Promise<void> {
  const validatedWrites = memoryWritesSchema.parse(writes)
  for (const write of validatedWrites) assertSafeMemoryName(write.name)

  const memoryDir = getAutoMemoryDir()
  await fs.mkdir(memoryDir, { recursive: true })

  for (const write of validatedWrites) {
    const memoryPath = path.join(memoryDir, `${write.name}.md`)
    if (write.action === 'delete') {
      await fs.rm(memoryPath, { force: true })
    } else {
      const memory: MemoryFile = {
        name: write.name,
        description: write.description,
        type: write.type,
        content: write.content,
        path: memoryPath,
        mtime: 0,
      }
      await fs.writeFile(memoryPath, serializeMemory(memory), 'utf8')
    }

    appendJournal({
      kind: 'memory_write',
      name: write.name,
      type: write.type,
      action: write.action,
    })
  }

  await regenerateMemoryIndex()
}
