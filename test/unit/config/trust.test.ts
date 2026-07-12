import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  clearConfigCacheForTests,
  getConfigTrustWarning,
  loadConfig,
} from '../../../src/config/load'
import { flushJournal } from '../../../src/memory/journal'
import {
  registerPromptHandler,
  requestPermission,
  unregisterPromptHandler,
} from '../../../src/permissions/confirm'
import { setConfiguredModel, setProvider } from '../../../src/providers'
import { query } from '../../../src/query'

// biome-ignore lint/suspicious/noExplicitAny: Bun.file is provided by the test runtime.
declare const Bun: any

const roots: string[] = []
const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
const originalDisableMemory = process.env.OCTONOESIS_DISABLE_MEMORY
const originalDisableCompact = process.env.OCTONOESIS_DISABLE_COMPACT

async function makeRepo(
  trustTrackedConfig: boolean,
  tracked: boolean,
): Promise<{
  root: string
  marker: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'config-trust-'))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  const marker = path.join(root, 'hook-fired')
  const configPath = path.join(root, '.octonoesis', 'config.json')
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({
      trustTrackedConfig,
      hooks: [{ event: 'session_start', command: `touch '${marker}'` }],
      permissions: { allowPatterns: ['Write'], denyPatterns: ['Bash(rm*)'] },
    }),
  )
  if (tracked) execFileSync('git', ['add', '.octonoesis/config.json'], { cwd: root })
  return { root, marker }
}

async function drain(root: string): Promise<void> {
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield { type: 'text_delta' as const, text: 'done' }
      yield { type: 'message_end' as const, usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  for await (const _event of query('trust probe', { repoRoot: root })) {
  }
}

afterEach(async () => {
  unregisterPromptHandler()
  setProvider(null)
  setConfiguredModel(undefined)
  clearConfigCacheForTests()
  await flushJournal()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  for (const [key, value] of Object.entries({
    OCTONOESIS_MEMORY_DIR: originalMemoryDir,
    OCTONOESIS_DISABLE_MEMORY: originalDisableMemory,
    OCTONOESIS_DISABLE_COMPACT: originalDisableCompact,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

describe('tracked config trust gate', () => {
  test('tracked config skips hooks and allowPatterns and emits the override warning', async () => {
    const { root, marker } = await makeRepo(false, true)
    process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'state')
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    process.env.OCTONOESIS_DISABLE_COMPACT = '1'
    const config = await loadConfig(root)
    expect(await getConfigTrustWarning(root, config)).toContain('trustTrackedConfig: true')
    let prompts = 0
    registerPromptHandler(async () => {
      prompts++
      return 'allow_once'
    })

    expect(await requestPermission('Write', { path: 'a.ts' }, { repoRoot: root, config })).toBe(
      'allow_once',
    )
    expect(
      await requestPermission('Bash', { command: 'rm build' }, { repoRoot: root, config }),
    ).toBe('deny')
    await drain(root)
    expect(prompts).toBe(1)
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test('explicit trust restores active settings and untracked config is unaffected', async () => {
    for (const [trusted, tracked] of [
      [true, true],
      [false, false],
    ] as const) {
      const { root, marker } = await makeRepo(trusted, tracked)
      process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'state')
      const config = await loadConfig(root)
      expect(await getConfigTrustWarning(root, config)).toBeUndefined()
      let prompted = false
      registerPromptHandler(async () => {
        prompted = true
        return 'deny'
      })
      expect(await requestPermission('Write', { path: 'a.ts' }, { repoRoot: root, config })).toBe(
        'allow_always',
      )
      await drain(root)
      expect(prompted).toBe(false)
      expect(await Bun.file(marker).exists()).toBe(true)
      unregisterPromptHandler()
    }
  })
})
