import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ToolContext } from '../tools/Tool'

// Symbol key for attaching the file state cache to ToolContext
const FILE_STATE_CACHE_KEY = Symbol('fileStateCache')

type FileStateCache = Map<string, string> // Map<absolutePath, contentHash>

interface ExtendedToolContext extends ToolContext {
  [FILE_STATE_CACHE_KEY]?: FileStateCache
}

/**
 * Lazily initializes and retrieves the file state cache from ToolContext.
 */
function getCache(ctx: ToolContext): FileStateCache {
  const extendedCtx = ctx as ExtendedToolContext
  let cache = extendedCtx[FILE_STATE_CACHE_KEY]
  if (!cache) {
    cache = new Map<string, string>()
    extendedCtx[FILE_STATE_CACHE_KEY] = cache
  }
  return cache
}

/**
 * Computes a SHA-256 hash of the given file content.
 */
export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

/**
 * Records a file read event by caching its content hash.
 * @param ctx ToolContext
 * @param filePath Resolved absolute path to the file
 * @param content Raw string content of the file
 */
export function recordFileRead(ctx: ToolContext, filePath: string, content: string): void {
  const cache = getCache(ctx)
  const hash = computeHash(content)
  cache.set(filePath, hash)
}

/**
 * Checks if a file is safe to edit.
 * Returns:
 * - 'ok': File is in cache and matches disk content.
 * - 'must_read_first': File has not been read in this session.
 * - 'file_changed_since_read': File has been modified on disk since it was read.
 * @param ctx ToolContext
 * @param filePath Resolved absolute path to the file
 */
export async function checkFileState(
  ctx: ToolContext,
  filePath: string,
): Promise<'ok' | 'must_read_first' | 'file_changed_since_read'> {
  const cache = getCache(ctx)
  const cachedHash = cache.get(filePath)

  if (!cachedHash) {
    return 'must_read_first'
  }

  try {
    const currentContent = await readFile(filePath, 'utf-8')
    const currentHash = computeHash(currentContent)

    if (currentHash === cachedHash) {
      return 'ok'
    }
    return 'file_changed_since_read'
  } catch {
    // If the file can't be read (e.g. deleted), we treat it as changed/missing.
    return 'file_changed_since_read'
  }
}
