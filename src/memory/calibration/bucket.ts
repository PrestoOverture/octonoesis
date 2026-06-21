import type { Fingerprint } from '../fingerprint/extract.ts'

/**
 * Computes a deterministic bucket key for a session.
 * Primary choice is the coarse error signature of the first failure fingerprint.
 * Falls back to the name of the tool executed (or 'unknown-tool') if no failures occur.
 *
 * @param fingerprints Array of fingerprints encountered in the session.
 * @param fallbackTool Optional name of the fallback tool.
 * @returns The resolved bucket key string.
 */
export function bucketKey(fingerprints: Fingerprint[], fallbackTool?: string): string {
  if (fingerprints && fingerprints.length > 0) {
    const firstFp = fingerprints[0]
    if (firstFp?.coarse) {
      return firstFp.coarse
    }
  }
  return fallbackTool || 'unknown-tool'
}
