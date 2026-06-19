import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getMemoryDir } from '../../utils/path.ts'
import { extractFingerprint } from './extract.ts'
import type { Fingerprint } from './extract.ts'

/**
 * CachedExtractor wraps the LLM-based fingerprint extractor with a local lookup cache.
 * Keyed by sha256(scrubbed_text). Loads existing values from fingerprint-cache.jsonl at startup.
 */
export class CachedExtractor {
  private cache: Map<string, Fingerprint> = new Map()
  private cacheFilePath: string
  private isLoaded = false

  constructor(cacheFilePath?: string) {
    this.cacheFilePath = cacheFilePath || path.join(getMemoryDir(), 'fingerprint-cache.jsonl')
  }

  private async ensureLoaded() {
    if (this.isLoaded) return
    this.isLoaded = true

    try {
      const fileContent = await fs.readFile(this.cacheFilePath, 'utf-8')
      const lines = fileContent.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.key && entry.fingerprint) {
            this.cache.set(entry.key, entry.fingerprint)
          }
        } catch {}
      }
    } catch (e) {
      // File may not exist yet, which is expected on first runs
    }
  }

  /**
   * Retrieves a cached fingerprint for the scrubbed output or creates one using the LLM extractor.
   */
  public async getOrCreate(
    scrubbed: string,
    command: string,
    ctx: { model: string },
  ): Promise<Fingerprint> {
    await this.ensureLoaded()

    const key = createHash('sha256').update(scrubbed).digest('hex')
    const cached = this.cache.get(key)
    if (cached) {
      return cached
    }

    // Call LLM extractor
    const fingerprint = await extractFingerprint(scrubbed, command, ctx)

    // Save in memory
    this.cache.set(key, fingerprint)

    // Persist to disk (append-only)
    try {
      const parentDir = path.dirname(this.cacheFilePath)
      await fs.mkdir(parentDir, { recursive: true })
      const entry = {
        key,
        command,
        scrubbed,
        fingerprint,
      }
      await fs.appendFile(this.cacheFilePath, `${JSON.stringify(entry)}\n`, 'utf-8')
    } catch (err) {
      // Fail-safe: do not crash if writing to cache file fails
    }

    return fingerprint
  }

  /**
   * Clears the in-memory cache and deletes the backing file.
   * Useful for cleaning up between test runs.
   */
  public async clearForTesting(): Promise<void> {
    this.cache.clear()
    this.isLoaded = false
    try {
      await fs.unlink(this.cacheFilePath)
    } catch {}
  }
}

// Export a default shared instance
export const defaultCachedExtractor = new CachedExtractor()
