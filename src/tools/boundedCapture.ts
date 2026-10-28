import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { taskLogPath } from '../tasks/framework'

const TRUNCATION_MARKER = '\n[output truncated]\n'
export const STDOUT_LIMIT = 30_000
export const STDERR_LIMIT = 10_000

/** Fixed UTF-16 head and ring-buffer tail; no retained strings reference incoming chunks. */
export class BoundedCapture {
  private readonly head: Uint16Array
  private readonly tail: Uint16Array
  private headLength = 0
  private tailLength = 0
  private tailPosition = 0
  private total = 0

  constructor(private readonly limit: number) {
    this.head = new Uint16Array(Math.ceil(limit / 2))
    this.tail = new Uint16Array(Math.floor(limit / 2))
  }

  get retainedChars(): number {
    return this.headLength + this.tailLength
  }

  get capacityBytes(): number {
    return this.head.byteLength + this.tail.byteLength
  }

  get truncated(): boolean {
    return this.total > this.limit
  }

  append(text: string): void {
    this.total += text.length
    let index = 0
    while (index < text.length && this.headLength < this.head.length) {
      this.head[this.headLength++] = text.charCodeAt(index++)
    }
    // Only the last tail.length code units of a large chunk can survive.
    index = Math.max(index, text.length - this.tail.length)
    for (; index < text.length; index++) {
      this.tail[this.tailPosition] = text.charCodeAt(index)
      this.tailPosition = (this.tailPosition + 1) % this.tail.length
      this.tailLength = Math.min(this.tailLength + 1, this.tail.length)
    }
  }

  text(): string {
    const head = String.fromCharCode(...this.head.subarray(0, this.headLength))
    const start = this.tailLength === this.tail.length ? this.tailPosition : 0
    const tail =
      String.fromCharCode(...this.tail.subarray(start, start + this.tailLength)) +
      String.fromCharCode(
        ...this.tail.subarray(0, Math.max(0, this.tailLength - (this.tail.length - start))),
      )
    return this.truncated
      ? head.slice(0, this.head.length - TRUNCATION_MARKER.length) + TRUNCATION_MARKER + tail
      : head + tail
  }
}

/** Decode incrementally and await each disk write before requesting another chunk. */
export async function captureStream(
  stream: ReadableStream<Uint8Array>,
  capture: BoundedCapture,
  append: (bytes: Uint8Array) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      capture.append(decoder.decode(value, { stream: true }))
      await append(value)
    }
    capture.append(decoder.decode())
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** Spill both complete byte streams to one task-directory log, keeping only bounded previews. */
export async function captureOutput(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
  repoRoot: string,
  stderrSuffix?: (preview: string) => Promise<string>,
): Promise<{ stdout: string; stderr: string; truncated?: true; output_log?: string }> {
  let logPath: string
  let log: Awaited<ReturnType<typeof fs.open>>
  while (true) {
    logPath = await taskLogPath(`bash-${crypto.randomUUID()}`)
    try {
      log = await fs.open(logPath, 'wx', 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const out = new BoundedCapture(STDOUT_LIMIT)
  const err = new BoundedCapture(STDERR_LIMIT)
  // At most one pending write per stream; each pump awaits its own append.
  let writes = Promise.resolve()
  const append = (bytes: Uint8Array): Promise<void> => {
    writes = writes.then(async () => {
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await log.write(bytes, offset, bytes.length - offset)
        if (bytesWritten === 0) throw new Error('Unable to write Bash output log')
        offset += bytesWritten
      }
    })
    return writes
  }
  const controller = new AbortController()
  const pumps = [
    captureStream(stdout, out, append, controller.signal),
    captureStream(stderr, err, append, controller.signal),
  ]
  try {
    await Promise.all(pumps)
    await log.close()
    if (stderrSuffix) err.append(await stderrSuffix(err.text()))
    if (!out.truncated && !err.truncated) {
      await fs.rm(logPath, { force: true })
      return { stdout: out.text(), stderr: err.text() }
    }
    const realLogPath = await fs.realpath(logPath)
    const relative = path.relative(repoRoot, realLogPath)
    const reportedPath =
      relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        ? realLogPath
        : relative.split(path.sep).join('/')
    return { stdout: out.text(), stderr: err.text(), truncated: true, output_log: reportedPath }
  } catch (error) {
    // Stop the other pump before closing its file, including failures of the shared writer.
    controller.abort(error)
    await Promise.allSettled(pumps)
    await log.close().catch(() => {})
    await fs.rm(logPath, { force: true })
    throw error
  }
}
