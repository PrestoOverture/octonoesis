import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { grepTool } from '../../../src/tools/Grep'
import { resetRgPath, resolveRgPath } from '../../../src/tools/rgPath'

let cacheRoot: string
const blob = (bytes = 'fake rg', name = 'rg.') => Object.assign(new Blob([bytes]), { name })
const unavailable = async (): Promise<{ rgPath: string }> => {
  throw new Error('npm package missing')
}

beforeEach(async () => {
  cacheRoot = await realpath(await mkdtemp(join(tmpdir(), 'rg-cache-test-')))
  resetRgPath()
})
afterEach(async () => {
  resetRgPath()
  await rm(cacheRoot, { recursive: true, force: true })
})

describe('ripgrep resolution', () => {
  it('extracts the first matching embedded file with a hash name and private directories', async () => {
    const hash = createHash('sha256').update('fake rg').digest('hex').slice(0, 16)
    const path = await resolveRgPath({
      cacheRoot,
      embeddedFiles: [blob('ignored', 'other-rg'), blob(), blob('second', 'rg')],
      importVscodeRipgrep: () => {
        throw new Error('embedded must precede npm')
      },
    })
    expect(path).toBe(join(cacheRoot, 'octonoesis', 'bin', `rg-${hash}`))
    expect(await readFile(path as string, 'utf8')).toBe('fake rg')
    expect((await stat(path as string)).mode & 0o777).toBe(0o755)
    for (const directory of ['octonoesis', 'octonoesis/bin']) {
      expect((await stat(join(cacheRoot, directory))).mode & 0o777).toBe(0o700)
    }
  })

  it('memoizes resolution and reuses verified cache without rewriting after reset', async () => {
    const deps = { cacheRoot, embeddedFiles: [blob()] }
    const pending = resolveRgPath(deps)
    expect(resolveRgPath({ embeddedFiles: [] })).toBe(pending)
    const path = (await pending) as string
    const before = await stat(path)
    resetRgPath()
    expect(await resolveRgPath(deps)).toBe(path)
    const after = await stat(path)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('atomically replaces tampered cache content', async () => {
    const deps = { cacheRoot, embeddedFiles: [blob()] }
    const path = (await resolveRgPath(deps)) as string
    await writeFile(path, 'tampered')
    const before = await stat(path)
    resetRgPath()
    expect(await resolveRgPath(deps)).toBe(path)
    expect(await readFile(path, 'utf8')).toBe('fake rg')
    expect((await stat(path)).ino).not.toBe(before.ino)
    expect((await stat(path)).mode & 0o777).toBe(0o755)
  })

  it('extracts and executes the real platform ripgrep when installed', async () => {
    let rgPath: string
    try {
      rgPath = (await import('@vscode/ripgrep')).rgPath
    } catch {
      return
    }
    const embedded = Object.assign(new Blob([await readFile(rgPath)]), { name: 'rg' })
    const path = (await resolveRgPath({ cacheRoot, embeddedFiles: [embedded] })) as string
    const result = spawnSync(path, ['--version'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.startsWith('ripgrep ')).toBe(true)
  })

  it('runs compiled Grep outside the checkout without node_modules or rg on PATH', async () => {
    let rgPath: string
    try {
      rgPath = (await import('@vscode/ripgrep')).rgPath
    } catch {
      return
    }
    const source = join(cacheRoot, 'standalone.ts')
    const executable = join(cacheRoot, 'standalone')
    const grepModule = fileURLToPath(new URL('../../../src/tools/Grep.ts', import.meta.url))
    await writeFile(
      source,
      `import { grepTool } from ${JSON.stringify(grepModule)};
const result = await grepTool.call({ pattern: 'embedded-search-marker', path: 'fixture.txt' }, { repoRoot: process.cwd() });
if (!result.ok || !result.value.includes('embedded-search-marker')) throw new Error(JSON.stringify(result));
console.log(result.value);`,
    )
    await writeFile(join(cacheRoot, 'fixture.txt'), 'embedded-search-marker\n')
    const build = spawnSync(
      process.execPath,
      [
        'build',
        source,
        rgPath,
        '--compile',
        '--asset-naming=[name].[ext]',
        '--outfile',
        executable,
      ],
      { encoding: 'utf8' },
    )
    expect(build.status).toBe(0)
    if (process.platform === 'darwin') {
      expect(spawnSync('codesign', ['--force', '--sign', '-', executable]).status).toBe(0)
    }
    const run = spawnSync(executable, [], {
      cwd: cacheRoot,
      env: { ...process.env, PATH: '/usr/bin:/bin', XDG_CACHE_HOME: cacheRoot },
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('fixture.txt:')
    expect(run.stdout).toContain('embedded-search-marker')
  })

  it('falls through extraction errors to npm before system', async () => {
    const badRoot = join(cacheRoot, 'file')
    await writeFile(badRoot, 'not a directory')
    const probes: string[] = []
    expect(
      await resolveRgPath({
        cacheRoot: badRoot,
        embeddedFiles: [blob()],
        importVscodeRipgrep: async () => ({ rgPath: '/npm/rg' }),
        probe: (path) => {
          probes.push(path)
          return true
        },
      }),
    ).toBe('/npm/rg')
    expect(probes).toEqual(['/npm/rg'])
  })

  it('falls back to system when npm rejects', async () => {
    const probes: string[] = []
    expect(
      await resolveRgPath({
        cacheRoot,
        embeddedFiles: [],
        importVscodeRipgrep: unavailable,
        probe: (path) => {
          probes.push(path)
          return true
        },
      }),
    ).toBe('rg')
    expect(probes).toEqual(['rg'])
  })

  it('checks npm then system and rejects unsuccessful probes', async () => {
    const probes: string[] = []
    expect(
      await resolveRgPath({
        cacheRoot,
        embeddedFiles: [],
        importVscodeRipgrep: async () => ({ rgPath: '/npm/rg' }),
        probe: (path) => {
          probes.push(path)
          return path === 'rg'
        },
      }),
    ).toBe('rg')
    expect(probes).toEqual(['/npm/rg', 'rg'])
  })

  it('returns null and an actionable Grep error without throwing when unavailable', async () => {
    expect(
      await resolveRgPath({
        cacheRoot,
        embeddedFiles: [],
        importVscodeRipgrep: unavailable,
        probe: () => false,
      }),
    ).toBe(null)
    const result = await grepTool.call({ pattern: 'anything' }, { repoRoot: cacheRoot })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.startsWith('ripgrep_not_found:')).toBe(true)
      expect(result.error).toContain('Install ripgrep')
      expect(result.error).toContain('@vscode/ripgrep')
    }
  })

  it('returns null when both probes throw', async () => {
    expect(
      await resolveRgPath({
        cacheRoot,
        embeddedFiles: [],
        importVscodeRipgrep: async () => ({ rgPath: '/npm/rg' }),
        probe: () => {
          throw new Error('spawn failed')
        },
      }),
    ).toBe(null)
  })
})
