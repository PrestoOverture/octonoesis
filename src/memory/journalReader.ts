import fs from 'node:fs/promises'

/** Byte offset and 1-based physical line number of a journal line boundary. */
export interface JournalPosition {
  offset: number
  line: number
}

/** Streams non-blank physical lines, decoding only after splitting on LF bytes. */
export async function* readJournalLines(
  filePath: string,
  position: JournalPosition = { offset: 0, line: 1 },
  chunkSize = 1024 * 1024,
): AsyncGenerator<{ line: number; text: string }> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid chunk size')
  const handle = await fs.open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    let valid =
      Number.isSafeInteger(position.offset) && position.offset >= 0 && position.offset <= size
    valid &&= Number.isSafeInteger(position.line) && position.line >= 1
    if (valid && position.offset > 0) {
      const byte = Buffer.alloc(1)
      const { bytesRead } = await handle.read(byte, 0, 1, position.offset - 1)
      valid = bytesRead === 1 && byte[0] === 10
    }
    let offset = valid ? position.offset : 0
    let line = valid ? position.line : 1
    const chunk = Buffer.alloc(chunkSize)
    let parts: Buffer[] = []
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      let start = 0
      const bytes = chunk.subarray(0, bytesRead)
      let end = bytes.indexOf(10, start)
      while (end !== -1) {
        let text: string
        if (parts.length === 0) {
          text = chunk.toString('utf8', start, end)
        } else {
          parts.push(bytes.subarray(start, end))
          text = Buffer.concat(parts).toString('utf8')
          parts = []
        }
        if (text.trim()) yield { line, text }
        line++
        start = end + 1
        end = bytes.indexOf(10, start)
      }
      if (start < bytesRead) parts.push(Buffer.from(chunk.subarray(start, bytesRead)))
    }
    const text = Buffer.concat(parts).toString('utf8')
    if (text.trim()) yield { line, text }
  } finally {
    await handle.close()
  }
}

/**
 * Finds the line boundary before a torn tail by counting LF bytes in fixed-size chunks.
 * @param filePath Path to the journal to inspect.
 * @returns The end boundary, or { offset: 0, line: 1 } for a missing journal.
 */
export async function captureJournalPosition(filePath: string): Promise<JournalPosition> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(filePath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { offset: 0, line: 1 }
    throw error
  }
  try {
    const chunk = Buffer.alloc(1024 * 1024)
    let offset = 0
    let boundary = 0
    let line = 1
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
      if (!bytesRead) return { offset: boundary, line }
      const bytes = chunk.subarray(0, bytesRead)
      let end = bytes.indexOf(10)
      while (end !== -1) {
        boundary = offset + end + 1
        line++
        end = bytes.indexOf(10, end + 1)
      }
      offset += bytesRead
    }
  } finally {
    await handle.close()
  }
}

/**
 * Streams bounded batches of physical journal text for full-file consumers.
 * Splits bytes at LF boundaries before decoding; only a line crossing a chunk
 * boundary is copied, while complete lines are decoded together without a copy.
 * @param filePath Journal path to read from the beginning.
 * @param chunkSize Maximum bytes read at a time; injectable for boundary checks.
 * @returns Decoded physical lines, including blank lines, from each byte batch.
 */
export async function* readJournalTextBatches(
  filePath: string,
  chunkSize = 1024 * 1024,
): AsyncGenerator<string[]> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid chunk size')
  const handle = await fs.open(filePath, 'r')
  try {
    const chunk = Buffer.alloc(chunkSize)
    let offset = 0
    let parts: Buffer[] = []
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset)
      if (!bytesRead) break
      offset += bytesRead
      const bytes = chunk.subarray(0, bytesRead)
      const end = bytes.lastIndexOf(10)
      if (end === -1) {
        parts.push(Buffer.from(bytes))
        continue
      }
      let start = 0
      if (parts.length) {
        start = bytes.indexOf(10) + 1
        parts.push(bytes.subarray(0, start - 1))
        yield [Buffer.concat(parts).toString('utf8')]
        parts = []
      }
      if (start <= end) yield chunk.toString('utf8', start, end).split('\n')
      if (end + 1 < bytesRead) parts.push(Buffer.from(bytes.subarray(end + 1)))
    }
    if (parts.length) yield [Buffer.concat(parts).toString('utf8')]
  } finally {
    await handle.close()
  }
}
