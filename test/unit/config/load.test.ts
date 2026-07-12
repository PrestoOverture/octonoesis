import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { clearConfigCacheForTests, loadConfig } from '../../../src/config/load'
import { ConfigValidationError, DEFAULT_CONFIG } from '../../../src/config/schema'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'config-load-'))
  roots.push(root)
  return root
}

async function writeConfig(root: string, content: string): Promise<void> {
  const configPath = path.join(root, '.octonoesis', 'config.json')
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, content)
}

afterEach(async () => {
  clearConfigCacheForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('loadConfig', () => {
  test('returns defaults when config.json is absent', async () => {
    expect(await loadConfig(await makeRoot())).toEqual(DEFAULT_CONFIG)
  })

  test('reports malformed JSON with the config path', async () => {
    const root = await makeRoot()
    await writeConfig(root, '{invalid')
    const configPath = path.join(root, '.octonoesis', 'config.json')

    let caught: unknown
    try {
      await loadConfig(root)
    } catch (error) {
      caught = error
    }
    expect(caught instanceof ConfigValidationError).toBe(true)
    expect(caught instanceof Error ? caught.message : '').toContain(configPath)
  })

  test('reports unrecognized keys with their exact path', async () => {
    const root = await makeRoot()
    await writeConfig(root, JSON.stringify({ typoedSetting: true }))
    await expect(loadConfig(root)).rejects.toThrow('typoedSetting: unrecognized key')
  })

  test('caches one read per repo root until the test-only clear', async () => {
    const root = await makeRoot()
    await writeConfig(root, JSON.stringify({ maxTurns: 2 }))
    expect((await loadConfig(root)).maxTurns).toBe(2)

    await writeConfig(root, JSON.stringify({ maxTurns: 7 }))
    expect((await loadConfig(root)).maxTurns).toBe(2)

    clearConfigCacheForTests()
    expect((await loadConfig(root)).maxTurns).toBe(7)
  })
})
