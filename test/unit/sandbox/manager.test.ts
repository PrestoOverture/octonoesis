import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertSandboxAvailable,
  isSandboxAvailable,
  resolveSandboxConfig,
} from '../../../src/sandbox/manager'
import { DEFAULT_ALLOW_WRITE, DEFAULT_DENY_READ } from '../../../src/sandbox/types'

const tempDirs: string[] = []

async function makeLayout(): Promise<{ repoRoot: string; homeDir: string; tmpDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'octonoesis-sandbox-manager-'))
  tempDirs.push(root)

  const repoRoot = path.join(root, 'repo')
  const homeDir = path.join(root, 'home')
  const tmpDir = path.join(root, 'tmp')
  await Promise.all([
    mkdir(repoRoot, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(tmpDir, { recursive: true }),
  ])

  return { repoRoot, homeDir, tmpDir }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolveSandboxConfig', () => {
  it('defaults to disabled and resolves the complete hardened path policy', async () => {
    const layout = await makeLayout()
    const resolved = resolveSandboxConfig({
      repoRoot: layout.repoRoot,
      environment: { homeDir: layout.homeDir, tmpDir: layout.tmpDir },
    })
    const canonicalRepoRoot = await realpath(layout.repoRoot)
    const canonicalHomeDir = await realpath(layout.homeDir)
    const canonicalTmpDir = await realpath(layout.tmpDir)

    expect(resolved.enabled).toBe(false)
    expect(resolved.repoRoot).toBe(canonicalRepoRoot)
    expect(resolved.filesystem.allowWrite).toContain(canonicalRepoRoot)
    expect(resolved.filesystem.allowWrite).toContain(canonicalTmpDir)
    for (const pathLiteral of DEFAULT_ALLOW_WRITE) {
      expect(resolved.filesystem.allowWrite).toContain(pathLiteral)
    }
    for (const deniedPath of DEFAULT_DENY_READ) {
      expect(resolved.filesystem.denyRead).toContain(
        path.join(canonicalHomeDir, deniedPath.slice(2)),
      )
    }
    expect(resolved.protectedWrite).toBe(path.join(canonicalRepoRoot, '.octonoesis'))
    expect(resolved.network.allowedDomains).toEqual([])
  })

  it('merges CLI/config sources and canonicalizes relative and home-relative extras', async () => {
    const layout = await makeLayout()
    const relativeWrite = path.join(layout.repoRoot, 'build-output')
    const homeRead = path.join(layout.homeDir, 'private-extra')
    await Promise.all([
      mkdir(relativeWrite, { recursive: true }),
      mkdir(homeRead, { recursive: true }),
    ])

    const resolved = resolveSandboxConfig({
      repoRoot: layout.repoRoot,
      cliEnabled: true,
      config: {
        enabled: false,
        filesystem: {
          allowWrite: ['build-output'],
          denyRead: ['~/private-extra'],
        },
        network: { allowedDomains: ['*'] },
      },
      environment: { homeDir: layout.homeDir, tmpDir: layout.tmpDir },
    })

    expect(resolved.enabled).toBe(true)
    expect(resolved.filesystem.allowWrite).toContain(await realpath(relativeWrite))
    expect(resolved.filesystem.denyRead).toContain(await realpath(homeRead))
    expect(resolved.network.allowedDomains).toEqual(['*'])
  })

  it('rejects every non-empty domain policy other than the exact wildcard', async () => {
    const layout = await makeLayout()

    for (const allowedDomains of [
      ['registry.npmjs.org'],
      ['*', 'registry.npmjs.org'],
      ['*', '*'],
    ]) {
      expect(() =>
        resolveSandboxConfig({
          repoRoot: layout.repoRoot,
          config: { enabled: true, network: { allowedDomains } },
          environment: { homeDir: layout.homeDir, tmpDir: layout.tmpDir },
        }),
      ).toThrow('Per-domain sandbox network filtering is not supported')
    }
  })

  it('realpaths symlinked extras and treats an explicit empty network list as deny-all', async () => {
    const layout = await makeLayout()
    const realWrite = path.join(layout.repoRoot, 'real-write')
    const writeLink = path.join(layout.repoRoot, 'write-link')
    const realRead = path.join(layout.homeDir, 'real-read')
    const readLink = path.join(layout.homeDir, 'read-link')
    await Promise.all([mkdir(realWrite), mkdir(realRead)])
    await Promise.all([symlink(realWrite, writeLink), symlink(realRead, readLink)])

    const resolved = resolveSandboxConfig({
      repoRoot: layout.repoRoot,
      config: {
        enabled: true,
        filesystem: { allowWrite: ['write-link'], denyRead: [readLink] },
        network: { allowedDomains: [] },
      },
      environment: { homeDir: layout.homeDir, tmpDir: layout.tmpDir },
    })

    expect(resolved.filesystem.allowWrite).toContain(await realpath(realWrite))
    expect(resolved.filesystem.allowWrite).not.toContain(writeLink)
    expect(resolved.filesystem.denyRead).toContain(await realpath(realRead))
    expect(resolved.filesystem.denyRead).not.toContain(readLink)
    expect(resolved.network.allowedDomains).toEqual([])
  })
})

describe('sandbox availability', () => {
  it('requires both macOS and a discoverable sandbox-exec binary', () => {
    expect(
      isSandboxAvailable({ platform: 'linux', findExecutable: () => '/usr/bin/sandbox-exec' }),
    ).toBe(false)
    expect(isSandboxAvailable({ platform: 'darwin', findExecutable: () => null })).toBe(false)
    expect(
      isSandboxAvailable({ platform: 'darwin', findExecutable: () => '/usr/bin/sandbox-exec' }),
    ).toBe(true)
  })

  it('turns an injected failed availability check into a startup error', () => {
    expect(() => assertSandboxAvailable(() => false)).toThrow(
      'Sandbox requested but macOS sandbox-exec is unavailable',
    )
  })
})
