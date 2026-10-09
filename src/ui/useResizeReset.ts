import { useApp, useStdout } from 'ink'
import { useLayoutEffect, useState } from 'react'

export const RESIZE_CLEAR = '\x1b[2J\x1b[3J\x1b[H'

/** Drain an empty frame before clearing; a new Static identity reprints at the new width. */
export function useResizeReset() {
  const { stdout, write } = useStdout()
  const { waitUntilRenderFlush } = useApp()
  const interactive = Boolean(stdout.isTTY && process.env.CI !== 'true')
  const [resizing, setResizing] = useState(false)
  const [epoch, setEpoch] = useState(0)
  useLayoutEffect(() => {
    if (!interactive) return
    let active = true
    let inResize = false
    let reprinting = false
    let revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const originalWrite = stdout.write
    const guardedWrite: typeof stdout.write = (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      // Drop Ink's entire overflow fallback, including its old-width Static replay.
      // During a burst all intermediate paints are discarded, but Ink still drains
      // its bookkeeping to the empty dynamic frame rendered by App.
      const clear =
        typeof chunk === 'string' && (chunk.includes('\x1b[2J') || chunk.includes('\x1b[3J'))
      if (reprinting && chunk === RESIZE_CLEAR) inResize = false
      const safe = inResize || (clear && !(reprinting && chunk === RESIZE_CLEAR)) ? '' : chunk
      return Reflect.apply(originalWrite, stdout, [safe, encoding, callback])
    }
    stdout.write = guardedWrite
    const onResize = () => {
      inResize = true
      setResizing(true)
      const current = ++revision
      clearTimeout(timer)
      timer = setTimeout(async () => {
        await waitUntilRenderFlush()
        if (!active || current !== revision) return
        // write() clears log-update BEFORE our home sequence, while writes are
        // suppressed, then restores the drained empty frame (one cursor newline).
        // The next Static paint can erase that row without moving above home.
        reprinting = true
        write(RESIZE_CLEAR)
        reprinting = false
        setEpoch((value) => value + 1)
        setResizing(false)
      }, 150)
    }
    stdout.prependListener('resize', onResize)
    return () => {
      active = false
      clearTimeout(timer)
      stdout.off('resize', onResize)
      if (stdout.write === guardedWrite) stdout.write = originalWrite
    }
  }, [interactive, stdout, write, waitUntilRenderFlush])
  return { resizing, epoch, interactive }
}
