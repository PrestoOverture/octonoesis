import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ToolContext } from '../tools/Tool'
import { writeFileAtomic } from '../utils/atomicWrite'
import { withFileLock } from '../utils/fileLock'
import { getMemoryDir } from '../utils/path'

const entrySchema = z.object({
  seq: z.number().int().positive(),
  ts: z.iso.datetime(),
  tool: z.enum(['Write', 'Edit']),
  path: z.string().min(1),
  snapshot: z.union([z.literal('absent'), z.string().regex(/^\d+-[a-f0-9-]+\.snapshot$/)]),
  after: z.object({ hash: z.string(), mtimeMs: z.number(), ctimeMs: z.number() }),
})
const manifestSchema = z.object({ repoRoot: z.string(), entries: z.array(entrySchema) })
export type FileHistoryEntry = z.infer<typeof entrySchema>
export type FileHistory = z.infer<typeof manifestSchema>
const lockOptions = { timeoutMs: 3000, staleMs: 600_000 }

function sessionDirectory(memoryDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid file history session id')
  return path.join(memoryDir, 'file-history', sessionId)
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep)
}

/** Validate both lexical containment and existing ancestors, including dangling symlinks. */
async function restorePath(repoRoot: string, relative: string): Promise<string> {
  const target = path.resolve(repoRoot, relative)
  if (path.isAbsolute(relative) || !inside(repoRoot, target) || target === repoRoot) {
    throw new Error(`Path outside repository: ${relative}`)
  }
  let ancestor = target
  while (true) {
    try {
      await fs.lstat(ancestor)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      ancestor = path.dirname(ancestor)
    }
  }
  const realAncestor = await fs.realpath(ancestor)
  if (!inside(repoRoot, realAncestor))
    throw new Error(`Path resolves outside repository: ${relative}`)
  return path.resolve(realAncestor, path.relative(ancestor, target))
}

async function readManifest(directory: string): Promise<FileHistory> {
  const manifest = manifestSchema.parse(
    JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')),
  )
  if (manifest.entries.some((entry, index) => entry.seq !== index + 1)) {
    throw new Error('Invalid file history sequence')
  }
  return manifest
}

function hash(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function warn(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Warning: file checkpoint unavailable: ${message.replace(/[\r\n]+/g, ' ')}`)
}

/** Stage prior bytes before writing, publishing the manifest only after a successful write. */
export async function writeWithCheckpoint(
  ctx: ToolContext,
  tool: 'Write' | 'Edit',
  target: string,
  content: string,
): Promise<void> {
  let attempted = false
  let writeError: unknown
  try {
    ctx.sessionId ??= randomUUID()
    const directory = sessionDirectory(ctx.memoryDir ?? getMemoryDir(), ctx.sessionId)
    await withFileLock(
      path.join(directory, '.lock'),
      async () => {
        attempted = true
        let staged: { manifest: FileHistory; entry: Omit<FileHistoryEntry, 'after'> } | undefined
        let snapshotPath: string | undefined
        try {
          const repoRoot = await fs.realpath(ctx.repoRoot)
          let manifest: FileHistory
          try {
            manifest = await readManifest(directory)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            manifest = { repoRoot, entries: [] }
          }
          if (manifest.repoRoot !== repoRoot)
            throw new Error('File history belongs to another repository')
          const relative = path.relative(repoRoot, target)
          const canonicalTarget = await restorePath(repoRoot, relative)
          let previous: Buffer | undefined
          try {
            previous = await fs.readFile(canonicalTarget)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          const seq = manifest.entries.length + 1
          const snapshot = previous === undefined ? 'absent' : `${seq}-${randomUUID()}.snapshot`
          if (previous !== undefined) {
            snapshotPath = path.join(directory, snapshot)
            await fs.writeFile(snapshotPath, previous, { mode: 0o600, flag: 'wx' })
          }
          staged = {
            manifest,
            entry: {
              seq,
              ts: new Date().toISOString(),
              tool,
              path: path.relative(repoRoot, canonicalTarget),
              snapshot,
            },
          }
        } catch (error) {
          warn(error)
        }

        try {
          await fs.writeFile(target, content, 'utf8')
        } catch (error) {
          writeError = error
          if (snapshotPath) await fs.rm(snapshotPath, { force: true }).catch(() => undefined)
          return
        }
        if (!staged) return
        try {
          const info = await fs.stat(target)
          staged.manifest.entries.push({
            ...staged.entry,
            after: {
              hash: hash(Buffer.from(content)),
              mtimeMs: info.mtimeMs,
              ctimeMs: info.ctimeMs,
            },
          })
          await writeFileAtomic(
            path.join(directory, 'manifest.json'),
            `${JSON.stringify(staged.manifest)}\n`,
          )
        } catch (error) {
          warn(error)
        }
      },
      lockOptions,
    )
  } catch (error) {
    warn(error)
  }
  // A checkpoint/lock failure must never prevent the authorized file write.
  if (!attempted) await fs.writeFile(target, content, 'utf8')
  if (writeError) throw writeError
}

/** Read a session only when its recorded repository matches the current real root. */
export async function loadFileHistory(
  memoryDir: string,
  sessionId: string,
  repoRoot: string,
): Promise<FileHistory> {
  const manifest = await readManifest(sessionDirectory(memoryDir, sessionId))
  if (manifest.repoRoot !== (await fs.realpath(repoRoot)))
    throw new Error('File history belongs to another repository')
  return manifest
}

/** Most recently written sessions for this repository, independent of conversation persistence. */
export async function listFileHistory(memoryDir: string, repoRoot: string) {
  let names: string[]
  try {
    names = await fs.readdir(path.join(memoryDir, 'file-history'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const sessions: { id: string; ts: string; count: number }[] = []
  const realRoot = await fs.realpath(repoRoot)
  for (const id of names) {
    let manifest: FileHistory
    try {
      manifest = await readManifest(sessionDirectory(memoryDir, id))
    } catch (error) {
      // An unsuccessful file write may have created the directory but no manifest.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const last = manifest.entries.at(-1)
    if (manifest.repoRoot === realRoot && last)
      sessions.push({ id, ts: last.ts, count: manifest.entries.length })
  }
  return sessions.sort(
    (left, right) => right.ts.localeCompare(left.ts) || left.id.localeCompare(right.id),
  )
}

export interface RestoreItem {
  path: string
  snapshot: string
  last: FileHistoryEntry
}

/** One restore per file, using its earliest prior state at or after the selected sequence. */
export function planFileRestore(history: FileHistory, seq: number): RestoreItem[] {
  if (!Number.isSafeInteger(seq) || !history.entries.some((entry) => entry.seq === seq)) {
    throw new Error('--to must name a recorded positive sequence number')
  }
  const plan = new Map<string, RestoreItem>()
  for (const entry of history.entries) {
    if (entry.seq < seq) continue
    const item = plan.get(entry.path)
    if (item) item.last = entry
    else plan.set(entry.path, { path: entry.path, snapshot: entry.snapshot, last: entry })
  }
  return [...plan.values()]
}

async function checkUnchanged(target: string, item: RestoreItem): Promise<void> {
  try {
    const info = await fs.stat(target)
    if (
      info.mtimeMs === item.last.after.mtimeMs &&
      info.ctimeMs === item.last.after.ctimeMs &&
      hash(await fs.readFile(target)) === item.last.after.hash
    )
      return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  throw new Error(`File changed after session's last write: ${item.path} (use --force to override)`)
}

/** Preflight every path, conflict and snapshot before making the first change. */
export async function restoreFiles(
  memoryDir: string,
  sessionId: string,
  history: FileHistory,
  plan: RestoreItem[],
  force: boolean,
): Promise<void> {
  const directory = sessionDirectory(memoryDir, sessionId)
  await withFileLock(
    path.join(directory, '.lock'),
    async () => {
      const current = await readManifest(directory)
      if (JSON.stringify(current) !== JSON.stringify(history))
        throw new Error('File history changed; run rewind again')
      const prepared: { item: RestoreItem; content: Buffer | undefined }[] = []
      for (const item of plan) {
        const target = await restorePath(history.repoRoot, item.path)
        if (!force) await checkUnchanged(target, item)
        const snapshot =
          item.snapshot === 'absent'
            ? undefined
            : await restorePath(await fs.realpath(directory), item.snapshot)
        prepared.push({
          item,
          content: snapshot === undefined ? undefined : await fs.readFile(snapshot),
        })
      }
      for (const { item, content } of prepared) {
        // Re-resolve immediately before mutation as well as during the full preflight.
        const target = await restorePath(history.repoRoot, item.path)
        if (!force) await checkUnchanged(target, item)
        if (content === undefined) await fs.rm(target, { force: true })
        else {
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, content)
        }
      }
    },
    lockOptions,
  )
}
