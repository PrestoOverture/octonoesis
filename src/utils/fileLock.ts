import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { dbg } from './debug'

/** Rules transactions may wait up to 60 seconds; holders age out after ten minutes. */
export const RULES_LOCK_OPTIONS = { timeoutMs: 60_000, staleMs: 600_000 }
/** Episode acquisition stays within the session hook timeout; holders age out after ten minutes. */
export const EPISODES_LOCK_OPTIONS = { timeoutMs: 3_000, staleMs: 600_000 }
interface Holder {
  pid: number
  acquired_at: number
  nonce: string
}

/** Raised when an advisory lock cannot be acquired within its timeout. */
export class LockTimeoutError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holderPid: number | undefined,
  ) {
    super(`Ledger lock timed out: ${lockPath} (holder pid: ${holderPid ?? 'unknown'})`)
    this.name = 'LockTimeoutError'
  }
}

const warnedPaths = new Set<string>()
/** Warn once per process per lock path; subsequent dropped updates go to debug output. */
export function warnLockTimeout(error: LockTimeoutError): void {
  const key = path.resolve(error.lockPath)
  if (warnedPaths.has(key)) dbg('memory', error.message)
  else {
    warnedPaths.add(key)
    console.error(error.message)
  }
}

async function readLockContent(lockPath: string): Promise<string | undefined> {
  try {
    return await readFile(lockPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parseHolder(content: string | undefined): Holder | undefined {
  if (content === undefined) return undefined
  try {
    const holder = JSON.parse(content) as Holder | null
    if (
      holder &&
      Number.isInteger(holder.pid) &&
      holder.pid > 0 &&
      Number.isFinite(holder.acquired_at) &&
      holder.acquired_at >= 0 &&
      typeof holder.nonce === 'string' &&
      holder.nonce.length > 0
    )
      return holder
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  return undefined
}

async function readHolder(lockPath: string): Promise<Holder | undefined> {
  return parseHolder(await readLockContent(lockPath))
}

async function removeOwned(lockPath: string, nonce: string): Promise<void> {
  if ((await readHolder(lockPath))?.nonce === nonce) {
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** Cross-process advisory exclusion; callers must use the same lock path. */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  options: { timeoutMs: number; staleMs: number },
): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true })
  const started = Date.now()
  let delay = 5
  let holder: Holder | undefined
  for (;;) {
    const nonce = randomUUID()
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const content = await readLockContent(lockPath)
      holder = parseHolder(content)
      let dead = false
      if (holder) {
        try {
          process.kill(holder.pid, 0)
        } catch (error) {
          dead = (error as NodeJS.ErrnoException).code === 'ESRCH'
        }
        if (dead || Date.now() - holder.acquired_at > options.staleMs) {
          await removeOwned(lockPath, holder.nonce)
          if (Date.now() - started < options.timeoutMs) continue
        }
      } else if (content !== undefined) {
        const info = await stat(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return undefined
        })
        // Allow create+write to finish before reclaiming a crash-torn payload.
        if (info && Date.now() - info.mtimeMs > 5_000) {
          if ((await readLockContent(lockPath)) === content) {
            await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
            })
          }
          if (Date.now() - started < options.timeoutMs) continue
        }
      }
      const remaining = options.timeoutMs - (Date.now() - started)
      if (remaining <= 0) throw new LockTimeoutError(lockPath, holder?.pid)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delay + Math.random() * delay, remaining)),
      )
      delay = Math.min(delay * 2, 100)
      continue
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: Date.now(), nonce }))
      await handle.close()
      return await fn()
    } finally {
      await handle.close().catch(() => undefined)
      await removeOwned(lockPath, nonce)
    }
  }
}
