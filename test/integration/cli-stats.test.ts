import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'

// biome-ignore lint/suspicious/noExplicitAny: global environment type bypass
declare const Bun: any

const TEST_DIR = path.join(__dirname, '../../test-cli-stats-memory')

describe('CLI stats options and subcommands', () => {
  const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR

  beforeEach(async () => {
    process.env.OCTONOESIS_MEMORY_DIR = TEST_DIR
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true })
    } catch {}
  })

  afterEach(async () => {
    if (originalMemoryDir === undefined) {
      Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true })
    } catch {}
  })

  it('should print statistics table via subcommand stats', async () => {
    await fs.mkdir(TEST_DIR, { recursive: true })

    const mockRecord = {
      session_id: 'sess-cli-sub',
      ts: new Date().toISOString(),
      bucket_key: 'bun-test|TypeError',
      model_id: 'gpt-5-nano',
      attempt_count: 3,
      first_attempt_success: false,
      user_modifications: 1,
      user_reverts: 0,
      resolved: true,
    }

    await fs.writeFile(
      path.join(TEST_DIR, 'calibration.jsonl'),
      `${JSON.stringify(mockRecord)}\n`,
      'utf8',
    )

    const proc = Bun.spawn({
      cmd: ['bun', 'src/cli.tsx', 'stats'],
      env: {
        ...process.env,
        OCTONOESIS_MEMORY_DIR: TEST_DIR,
        // Stats paths make no API call; a dummy key satisfies the startup presence
        // check on keyless environments (CI) without violating the no-live-key policy.
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'test-dummy-key',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    expect(stderr.trim()).toBe('')
    expect(stdout).toContain('Bucket')
    expect(stdout).toContain('bun-test|TypeError')
    expect(stdout).toContain('uncertain')
  })

  it('should print statistics table via option --stats', async () => {
    await fs.mkdir(TEST_DIR, { recursive: true })

    const mockRecord = {
      session_id: 'sess-cli-opt',
      ts: new Date().toISOString(),
      bucket_key: 'tsc|SyntaxError',
      model_id: 'gpt-5-nano',
      attempt_count: 5,
      first_attempt_success: true,
      user_modifications: 0,
      user_reverts: 0,
      resolved: true,
    }

    await fs.writeFile(
      path.join(TEST_DIR, 'calibration.jsonl'),
      `${JSON.stringify(mockRecord)}\n`,
      'utf8',
    )

    const proc = Bun.spawn({
      cmd: ['bun', 'src/cli.tsx', '--stats'],
      env: {
        ...process.env,
        OCTONOESIS_MEMORY_DIR: TEST_DIR,
        // Stats paths make no API call; a dummy key satisfies the startup presence
        // check on keyless environments (CI) without violating the no-live-key policy.
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'test-dummy-key',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    expect(stderr.trim()).toBe('')
    expect(stdout).toContain('Bucket')
    expect(stdout).toContain('tsc|SyntaxError')
    expect(stdout).toContain('uncertain')
  })
})
