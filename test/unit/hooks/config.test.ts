import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ConfigValidationError } from '../../../src/config/schema'
import { loadHooksConfig } from '../../../src/hooks/config'

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'hooks-config-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

describe('loadHooksConfig', () => {
  test('returns an empty list when config.json is absent or has no hooks key', async () => {
    const repo = await root()
    expect(await loadHooksConfig(repo)).toEqual([])
    await mkdir(path.join(repo, '.octonoesis'), { recursive: true })
    await writeFile(path.join(repo, '.octonoesis/config.json'), '{"futureKey":true}')
    expect(await loadHooksConfig(repo)).toEqual([])
  })

  test('loads only the existing hook schema from config.json', async () => {
    const repo = await root()
    await mkdir(path.join(repo, '.octonoesis'), { recursive: true })
    await writeFile(
      path.join(repo, '.octonoesis/config.json'),
      JSON.stringify({
        ignoredUntilPhase33: true,
        hooks: [{ event: 'pre_tool_use', toolPattern: 'Bash', command: 'exit 2' }],
      }),
    )
    expect(await loadHooksConfig(repo)).toEqual([
      { event: 'pre_tool_use', toolPattern: 'Bash', command: 'exit 2' },
    ])
  })

  test('fails fast with the malformed hooks path', async () => {
    const repo = await root()
    await mkdir(path.join(repo, '.octonoesis'), { recursive: true })
    await writeFile(
      path.join(repo, '.octonoesis/config.json'),
      JSON.stringify({ hooks: [{ event: 'stop' }] }),
    )
    let caught: unknown
    try {
      await loadHooksConfig(repo)
    } catch (error) {
      caught = error
    }
    expect(caught instanceof ConfigValidationError).toBe(true)
    expect(caught instanceof Error ? caught.message : '').toContain('hooks.0.command:')
  })

  test('rejects matcher timeout overrides from the strict config surface', async () => {
    const repo = await root()
    await mkdir(path.join(repo, '.octonoesis'), { recursive: true })
    await writeFile(
      path.join(repo, '.octonoesis/config.json'),
      JSON.stringify({
        hooks: [{ event: 'stop', command: 'echo done', timeoutMs: 30_000 }],
      }),
    )
    let caught: unknown
    try {
      await loadHooksConfig(repo)
    } catch (error) {
      caught = error
    }
    expect(caught instanceof ConfigValidationError).toBe(true)
    expect(caught instanceof Error ? caught.message : '').toContain(
      'hooks.0.timeoutMs: unrecognized key',
    )
  })

  test('reports invalid JSON with the config file path', async () => {
    const repo = await root()
    const configPath = path.join(repo, '.octonoesis/config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, '{invalid')
    await expect(loadHooksConfig(repo)).rejects.toThrow(configPath)
  })
})
