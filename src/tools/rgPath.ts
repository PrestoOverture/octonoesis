import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

declare const Bun: { embeddedFiles: Array<Blob & { name: string }> }

type RgPathDeps = {
  embeddedFiles?: Array<Blob & { name: string }>
  cacheRoot?: string
  importVscodeRipgrep?: () => Promise<{ rgPath: string }>
  probe?: (path: string) => boolean | Promise<boolean>
}

let resolution: Promise<string | null> | undefined

export function resetRgPath(): void {
  resolution = undefined
}

function probeVersion(path: string): boolean {
  const result = spawnSync(path, ['--version'], { encoding: 'utf-8' })
  return result.status === 0 && result.stdout.startsWith('ripgrep ')
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function resolvePath(deps: RgPathDeps): Promise<string | null> {
  try {
    const files = deps.embeddedFiles ?? (typeof Bun === 'undefined' ? [] : Bun.embeddedFiles)
    const embedded = files.find((file) => ['rg', 'rg.', 'rg.exe'].includes(file.name))
    if (embedded) {
      const bytes = new Uint8Array(await embedded.arrayBuffer())
      const hash = sha256(bytes)
      const root = deps.cacheRoot || process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
      const directory = join(root, 'octonoesis', 'bin')
      await mkdir(join(root, 'octonoesis'), { recursive: true, mode: 0o700 })
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const target = join(directory, `rg-${hash.slice(0, 16)}`)
      try {
        if (sha256(await readFile(target)) === hash) return target
      } catch {}
      const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o700 })
        await chmod(temporary, 0o755)
        await rename(temporary, target)
      } finally {
        await unlink(temporary).catch(() => {})
      }
      return target
    }
  } catch {}

  const probe = deps.probe ?? probeVersion
  try {
    const { rgPath } = await (deps.importVscodeRipgrep ?? (() => import('@vscode/ripgrep')))()
    if (await probe(rgPath)) return rgPath
  } catch {}
  try {
    if (await probe('rg')) return 'rg'
  } catch {}
  return null
}

export function resolveRgPath(deps: RgPathDeps = {}): Promise<string | null> {
  resolution ??= resolvePath(deps)
  return resolution
}
