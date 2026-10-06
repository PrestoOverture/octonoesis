import { useApp, useStdout } from 'ink'
import { useLayoutEffect, useState } from 'react'
import { prepareScreenSequence } from './screen'

/** Reflow invalidates Ink's remembered erase height. Reset after the resize burst settles. */
export function useResizeReset(): boolean {
  const { stdout, write } = useStdout()
  const { waitUntilRenderFlush } = useApp()
  const [resizing, setResizing] = useState(false)
  useLayoutEffect(() => {
    if (!stdout.isTTY) return
    let active = true
    let inResize = false
    let revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const originalWrite = stdout.write
    // Ink's height-shrink fallback includes clearTerminal, which wipes scrollback.
    // Allow its bookkeeping to settle, but never send those clears during a resize.
    const guardedWrite: typeof stdout.write = (
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      // Drop the whole fallback write: it also replays all Static history. The
      // debounced reset below will replay just the current dynamic region instead.
      const safe =
        inResize &&
        typeof chunk === 'string' &&
        (chunk.includes('\x1b[2J') || chunk.includes('\x1b[3J'))
          ? ''
          : chunk
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
        // Write from the existing cursor first, preserving the visible content in scrollback.
        stdout.write(prepareScreenSequence(stdout.rows))
        // Ink clears its cached erase state and replays only the current dynamic frame.
        // Doing this after the reset also forces a redraw when its text has not changed.
        write('')
        inResize = false
        setResizing(false)
      }, 150)
    }
    // Guard before Ink's own resize listener can take its destructive height fallback.
    stdout.prependListener('resize', onResize)
    return () => {
      active = false
      clearTimeout(timer)
      stdout.off('resize', onResize)
      if (stdout.write === guardedWrite) stdout.write = originalWrite
    }
  }, [stdout, write, waitUntilRenderFlush])
  return resizing
}
