import fs from 'node:fs/promises'
import path from 'node:path'

const tailPrefixes = new Map<string, string>()
const pendingAppends = new Map<string, Promise<void>>()

/**
 * Appends JSONL, separating a torn tail on the first append per path or after failure.
 * @param target The path to the JSONL file.
 * @param data The newline-terminated JSONL contents to append.
 * @returns A promise resolving when the append completes.
 */
export function appendJsonl(target: string, data: string): Promise<void> {
  const resolved = path.resolve(target)
  const write = (pendingAppends.get(resolved) ?? Promise.resolve()).then(async () => {
    let prefix = tailPrefixes.get(resolved) ?? ''
    if (!tailPrefixes.has(resolved)) {
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      try {
        handle = await fs.open(resolved, 'r')
        const { size } = await handle.stat()
        if (size > 0) {
          const lastByte = Buffer.alloc(1)
          const { bytesRead } = await handle.read(lastByte, 0, 1, size - 1)
          if (bytesRead === 1 && lastByte[0] !== 10) prefix = '\n'
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      } finally {
        await handle?.close()
      }
      tailPrefixes.set(resolved, prefix)
    }
    try {
      await fs.appendFile(resolved, prefix + data, 'utf8')
    } catch (error) {
      tailPrefixes.delete(resolved)
      throw error
    }
    tailPrefixes.set(resolved, '')
  })
  const settled = write.catch(() => undefined)
  pendingAppends.set(resolved, settled)
  void settled.then(() => {
    if (pendingAppends.get(resolved) === settled) pendingAppends.delete(resolved)
  })
  return write
}
