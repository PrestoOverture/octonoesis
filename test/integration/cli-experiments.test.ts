import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess API is not in the configured TS types
declare const Bun: any

const repoRoot = path.resolve(__dirname, '../..')
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempMemoryDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-cli-experiments-'))
  tempDirs.push(dir)
  return dir
}

function keylessEnv(memoryDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'ANTHROPIC_API_KEY' && key !== 'OPENAI_API_KEY' && value !== undefined) {
      env[key] = value
    }
  }
  env.OCTONOESIS_MEMORY_DIR = memoryDir
  return env
}

async function runCli(memoryDir: string, args: string[]) {
  const proc = Bun.spawn({
    cmd: ['bun', '--no-env-file', 'src/cli.tsx', 'experiments', ...args],
    cwd: repoRoot,
    env: keylessEnv(memoryDir),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function writeFixture(dir: string, name: string, body: unknown): Promise<string> {
  const filePath = path.join(dir, name)
  await fs.writeFile(filePath, JSON.stringify(body), 'utf8')
  return filePath
}

const validExperiment = {
  id: 'exp-cli-test',
  hypothesis: 'Variant B beats variant A on hit rate.',
  endpoints: { primary: 'hit_rate_by_prompt_hash', secondary: ['repeat_failure_rate'] },
  test: { method: 'interleaved session-sticky A/B', pass_line: 'p < 0.05 one-sided' },
  arms: [
    { name: 'A', prompt_hashes: ['hash-a'] },
    { name: 'B', prompt_hashes: ['hash-b'] },
  ],
}

const invalidExperiment = {
  id: 'not-a-valid-id',
  hypothesis: '',
  endpoints: { primary: 'p', secondary: [] },
  test: { method: 'm', pass_line: 'x' },
}

describe('experiments CLI (keyless)', () => {
  it('reports a friendly empty message and exits 0 when no registry exists', async () => {
    // Point at a nonexistent child of the temp dir: mkdtemp creates the parent, so the
    // zero-write assertion must target a path the test itself never created.
    const memoryDir = path.join(await tempMemoryDir(), 'mem')

    const result = await runCli(memoryDir, [])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('No registered experiments')

    let exists = true
    try {
      await fs.stat(memoryDir)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  it('registers a valid experiment then lists it', async () => {
    const memoryDir = await tempMemoryDir()
    const fixtureDir = await tempMemoryDir()
    const validPath = await writeFixture(fixtureDir, 'valid.json', validExperiment)

    const register = await runCli(memoryDir, ['--register', validPath])
    expect(register.exitCode).toBe(0)
    expect(register.stderr).toBe('')
    expect(register.stdout).toContain('exp-cli-test')

    const list = await runCli(memoryDir, [])
    expect(list.exitCode).toBe(0)
    expect(list.stderr).toBe('')
    expect(list.stdout).toContain('exp-cli-test')
    expect(list.stdout).toContain('registered')

    const registryContent = await fs.readFile(path.join(memoryDir, 'experiments.jsonl'), 'utf8')
    expect(registryContent.trim().split('\n').length).toBe(1)
  })

  it('registers with --running so the record is immediately usable by assignment', async () => {
    const memoryDir = await tempMemoryDir()
    const fixtureDir = await tempMemoryDir()
    const validPath = await writeFixture(fixtureDir, 'valid.json', validExperiment)

    const register = await runCli(memoryDir, ['--register', validPath, '--running'])
    expect(register.exitCode).toBe(0)

    const list = await runCli(memoryDir, [])
    expect(list.stdout).toContain('running')
  })

  it('rejects an invalid experiment file with a non-zero exit and appends nothing', async () => {
    const memoryDir = await tempMemoryDir()
    const fixtureDir = await tempMemoryDir()
    const invalidPath = await writeFixture(fixtureDir, 'invalid.json', invalidExperiment)

    const register = await runCli(memoryDir, ['--register', invalidPath])
    expect(register.exitCode).not.toBe(0)
    expect(register.stderr.length).toBeGreaterThan(0)

    let exists = true
    try {
      await fs.stat(path.join(memoryDir, 'experiments.jsonl'))
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })
})
