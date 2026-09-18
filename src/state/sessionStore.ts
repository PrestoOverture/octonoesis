import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CanonicalMessage } from '../providers/types.ts'
import { getMemoryDir } from '../utils/path.ts'

const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('tool_use'),
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_result'),
      tool_use_id: z.string(),
      content: z.string(),
      is_error: z.boolean().optional(),
    })
    .strict(),
])

const messageContentSchema = z.union([z.string(), z.array(contentBlockSchema)])
const canonicalMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: messageContentSchema }).strict(),
  z.object({ role: z.literal('assistant'), content: z.array(contentBlockSchema) }).strict(),
  z
    .object({
      role: z.literal('tool'),
      tool_use_id: z.string(),
      content: messageContentSchema,
    })
    .strict(),
])

const storedSessionSchema = z
  .object({
    schema_version: z.literal(1),
    session_id: z.string().min(1),
    updated_at: z.string().refine((value) => !Number.isNaN(new Date(value).getTime())),
    model: z.string().min(1),
    repo_root: z.string().min(1),
    messages: z.array(canonicalMessageSchema),
  })
  .strict()

/** Persistent JSON snapshot of a saved interactive session and its message history. */
export interface StoredSession {
  schema_version: 1
  session_id: string
  updated_at: string
  model: string
  repo_root: string
  messages: CanonicalMessage[]
}

/** Parameters required to save or update a session snapshot in the session store. */
export interface SaveSessionInput {
  sessionId: string
  model: string
  repoRoot: string
  messages: CanonicalMessage[]
}

/** Common options for session storage operations, allowing directory or time overrides. */
export interface SessionStoreOptions {
  memoryDir?: string
  now?: Date
}

/** Options for querying saved sessions, optionally filtering by repository root. */
export interface ListSessionsOptions extends SessionStoreOptions {
  repoRoot?: string
}

export const SESSION_RETENTION_LIMIT = 50

export class SessionStoreError extends Error {
  override name = 'SessionStoreError'
}

/**
 * Returns the directory path where session snapshots are stored (<memoryDir>/sessions).
 * @param memoryDir The memory directory root.
 * @returns Path to the sessions storage directory.
 */
function sessionDirectory(memoryDir: string): string {
  return path.join(memoryDir, 'sessions')
}

/**
 * Validates that a session identifier contains only safe alphanumeric and hyphen/underscore characters.
 * @param sessionId The session ID to validate.
 * @throws {SessionStoreError} If sessionId contains illegal characters.
 */
function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new SessionStoreError(`Invalid saved session id: ${sessionId}`)
  }
}

/**
 * Computes the target JSON file path for a session ID within the sessions directory.
 * @param memoryDir The memory directory root.
 * @param sessionId The validated session ID.
 * @returns Path to the session JSON file.
 * @throws {SessionStoreError} If sessionId fails validation.
 */
function sessionPath(memoryDir: string, sessionId: string): string {
  validateSessionId(sessionId)
  return path.join(sessionDirectory(memoryDir), `${sessionId}.json`)
}

/**
 * Validates tool-use/result ordering and rejects unpaired or dangling tool calls.
 * @param messages Array of canonical conversation messages.
 * @param sessionId The session ID for error reporting.
 * @throws {SessionStoreError} If a pending ID is duplicated or a tool call is unpaired or dangling.
 */
function validateToolPairing(messages: CanonicalMessage[], sessionId: string): void {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (pending.size > 0) break
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue
        if (pending.has(block.id)) {
          throw new SessionStoreError(
            `Saved session ${sessionId} contains duplicate tool_use id ${block.id}`,
          )
        }
        pending.add(block.id)
      }
      continue
    }
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_use_id)) {
        throw new SessionStoreError(
          `Saved session ${sessionId} has an unpaired tool_result id ${message.tool_use_id}`,
        )
      }
      continue
    }
    if (pending.size > 0) break
  }
  const dangling = pending.values().next().value
  if (dangling) {
    throw new SessionStoreError(`Saved session ${sessionId} has dangling tool_use id ${dangling}`)
  }
}

/**
 * Parses and validates an unverified JSON object against storedSessionSchema.
 * @param raw The raw unverified object.
 * @param source Identifier or filename for error reporting.
 * @returns The validated StoredSession.
 * @throws {SessionStoreError} If schema validation or tool pairing checks fail.
 */
function parseStoredSession(raw: unknown, source: string): StoredSession {
  const parsed = storedSessionSchema.safeParse(raw)
  if (!parsed.success) {
    throw new SessionStoreError(`Invalid saved session ${source}: ${parsed.error.message}`)
  }
  const session = parsed.data as StoredSession
  validateToolPairing(session.messages, session.session_id)
  return session
}

/**
 * Sorts sessions by updated_at timestamp descending, breaking ties by session_id ascending.
 * @param sessions Array of stored sessions to sort.
 * @returns Sorted array of stored sessions.
 */
function sortMostRecent(sessions: StoredSession[]): StoredSession[] {
  return sessions.sort(
    (left, right) =>
      new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime() ||
      left.session_id.localeCompare(right.session_id),
  )
}

/**
 * Reads all stored session files from disk, optionally skipping or throwing on invalid files.
 * @param memoryDir The memory directory root.
 * @param invalid Mode: 'throw' on first error, or 'skip' corrupted files.
 * @returns A promise resolving to an array of valid StoredSessions sorted most recent first.
 * @throws {Error} If reading a file fails and invalid mode is 'throw'.
 */
async function readSessionFiles(
  memoryDir: string,
  invalid: 'throw' | 'skip',
): Promise<StoredSession[]> {
  const directory = sessionDirectory(memoryDir)
  let files: string[]
  try {
    files = await fs.readdir(directory)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  }

  const sessions: StoredSession[] = []
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const sessionId = file.slice(0, -'.json'.length)
    try {
      sessions.push(await loadSession(sessionId, { memoryDir }))
    } catch (error) {
      if (invalid === 'throw') throw error
    }
  }
  return sortMostRecent(sessions)
}

/**
 * Enforces the SESSION_RETENTION_LIMIT (50 sessions) by removing the oldest session files on disk.
 * @param memoryDir The memory directory root.
 */
async function enforceRetention(memoryDir: string): Promise<void> {
  const sessions = await readSessionFiles(memoryDir, 'skip')
  await Promise.all(
    sessions
      .slice(SESSION_RETENTION_LIMIT)
      .map((session) => fs.rm(sessionPath(memoryDir, session.session_id), { force: true })),
  )
}

/**
 * Atomically saves a session snapshot to disk using a temporary file and rename (mode 0o600).
 * Enforces retention limits after saving.
 * @param input Session attributes to persist (sessionId, model, repoRoot, messages).
 * @param options Optional memory directory override and clock timestamp.
 * @returns A promise resolving to the validated StoredSession.
 * @throws {SessionStoreError} If session data fails validation or tool pairing checks.
 */
export async function saveSession(
  input: SaveSessionInput,
  options: SessionStoreOptions = {},
): Promise<StoredSession> {
  const memoryDir = options.memoryDir ?? getMemoryDir()
  const directory = sessionDirectory(memoryDir)
  const target = sessionPath(memoryDir, input.sessionId)
  const session = parseStoredSession(
    {
      schema_version: 1,
      session_id: input.sessionId,
      updated_at: (options.now ?? new Date()).toISOString(),
      model: input.model,
      repo_root: input.repoRoot,
      messages: structuredClone(input.messages),
    },
    input.sessionId,
  )
  await fs.mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${input.sessionId}.${crypto.randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, `${JSON.stringify(session)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, target)
    await enforceRetention(memoryDir)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
  return session
}

/**
 * Loads and validates a stored session snapshot from disk by its session ID.
 * @param sessionId The unique session ID.
 * @param options Optional memory directory override.
 * @returns The validated StoredSession.
 * @throws {SessionStoreError} If the session file is not found, unreadable, or invalid.
 */
export async function loadSession(
  sessionId: string,
  options: SessionStoreOptions = {},
): Promise<StoredSession> {
  const memoryDir = options.memoryDir ?? getMemoryDir()
  const filePath = sessionPath(memoryDir, sessionId)
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new SessionStoreError(`Saved session ${sessionId} was not found`)
    }
    throw new SessionStoreError(
      `Could not read saved session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  try {
    return parseStoredSession(JSON.parse(content), sessionId)
  } catch (error) {
    if (error instanceof SessionStoreError) throw error
    throw new SessionStoreError(
      `Invalid saved session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Lists all stored sessions from disk, sorted most recent first.
 * Optionally filters by repository root path.
 * @param options Optional memory directory and repoRoot filter.
 * @returns An array of StoredSession records.
 */
export async function listSessions(options: ListSessionsOptions = {}): Promise<StoredSession[]> {
  const memoryDir = options.memoryDir ?? getMemoryDir()
  const sessions = await readSessionFiles(memoryDir, 'throw')
  return options.repoRoot
    ? sessions.filter((session) => session.repo_root === options.repoRoot)
    : sessions
}

/**
 * Loads the most recently updated session matching the specified repository root.
 * @param repoRoot Absolute path to the repository root.
 * @param options Optional memory directory override.
 * @returns The most recent StoredSession or null if none found.
 */
export async function loadMostRecentSession(
  repoRoot: string,
  options: SessionStoreOptions = {},
): Promise<StoredSession | null> {
  return (await listSessions({ ...options, repoRoot }))[0] ?? null
}

/**
 * Extracts a truncated preview of the first user message for CLI display.
 * @param messages Array of canonical conversation messages.
 * @param limit Maximum character length of the preview string (default: 60).
 * @returns Truncated preview text.
 */
function firstUserPreview(messages: CanonicalMessage[], limit = 60): string {
  const firstUser = messages.find((message) => message.role === 'user')
  if (!firstUser || firstUser.role !== 'user') return '(no user message)'
  const text = (
    typeof firstUser.content === 'string'
      ? firstUser.content
      : firstUser.content
          .filter((block) => block.type === 'text')
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('')
  )
    .replace(/\s+/g, ' ')
    .trim()
  const characters = Array.from(text)
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : text
}

/**
 * Formats a list of stored sessions as an aligned ASCII table for terminal display.
 * @param sessions Array of stored sessions to format.
 * @returns A formatted multi-line table string.
 */
export function formatSessionList(sessions: StoredSession[]): string {
  if (sessions.length === 0) return 'No saved sessions.'
  const headers = ['ID', 'Updated', 'Messages', 'Model', 'First user message']
  const rows = sessions.map((session) => [
    session.session_id,
    session.updated_at,
    String(session.messages.length),
    session.model,
    firstUserPreview(session.messages),
  ])
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const renderRow = (row: string[]) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join('  ')
      .trimEnd()
  return [
    renderRow(headers),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(renderRow),
  ].join('\n')
}
