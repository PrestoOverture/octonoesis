import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { defaultCachedExtractor } from '../../../src/memory/fingerprint/cache'
import { flushJournal } from '../../../src/memory/journal'
import { verify } from '../../../src/memory/verifier'
import { setProvider } from '../../../src/providers/index'
import type { LLMProvider } from '../../../src/providers/types'

describe('Verifier Runner', () => {
  const tempDir = join(os.tmpdir(), `octonoesis-verifier-test-${Date.now()}`)
  let originalMemoryDir: string | undefined
  let llmCallCount = 0

  beforeAll(async () => {
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    process.env.OCTONOESIS_MEMORY_DIR = tempDir
    await rm(tempDir, { recursive: true, force: true })
    await mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    if (originalMemoryDir === undefined) {
      process.env.OCTONOESIS_MEMORY_DIR = undefined
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    await rm(tempDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    llmCallCount = 0
    // Mock provider for error fingerprint extraction
    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* () {
        llmCallCount++
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            tool: 'bun-test',
            error_class: 'TypeError',
            file: 'src/buggy.ts',
            expression: "evaluating 'user.name'",
          }),
        }
      },
    }
    setProvider(mockProvider)
  })

  afterEach(async () => {
    setProvider(null)
    await defaultCachedExtractor.clearForTesting()
    await rm(join(tempDir, 'journal.jsonl'), { force: true })
  })

  it('should return PASS and zero fingerprints when command exits with 0', async () => {
    const result = await verify('echo "Everything is fine"', tempDir)
    expect(result.verdict).toBe('PASS')
    expect(result.exit_code).toBe(0)
    expect(result.fingerprints.length).toBe(0)
    expect(result.stale).toBe(false)

    // Verify journal write
    await flushJournal()
    const journalContent = await readFile(join(tempDir, 'journal.jsonl'), 'utf-8')
    const event = JSON.parse(journalContent.trim())
    expect(event.kind).toBe('verify')
    expect(event.verdict).toBe('PASS')
    expect(event.exit_code).toBe(0)
    expect(event.command).toBe('echo "Everything is fine"')
  })

  it('should return FAIL and extract fingerprints when command exits non-zero', async () => {
    const result = await verify(
      'echo "TypeError: user.name is undefined at src/buggy.ts:1" && exit 1',
      tempDir,
    )
    expect(result.verdict).toBe('FAIL')
    expect(result.exit_code).toBe(1)
    expect(result.fingerprints.length).toBe(1)

    const fp = result.fingerprints[0]
    expect(fp).toBeDefined()
    expect(fp?.coarse).toBe('bun-test|TypeError')
    expect(fp?.medium).toBe('bun-test|TypeError|src/buggy.ts')
    expect(fp?.fine).toBe("bun-test|TypeError|src/buggy.ts|evaluating 'user.name'")
    expect(llmCallCount).toBe(1)

    // Verify journal write
    await flushJournal()
    const journalContent = await readFile(join(tempDir, 'journal.jsonl'), 'utf-8')
    const event = JSON.parse(journalContent.trim())
    expect(event.kind).toBe('verify')
    expect(event.verdict).toBe('FAIL')
    expect(event.exit_code).toBe(1)
    expect(event.fingerprints.length).toBe(1)
    expect(event.fingerprints[0].fine).toBe(
      "bun-test|TypeError|src/buggy.ts|evaluating 'user.name'",
    )
  })

  it('should reject prior to execution when AbortSignal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    expect(verify('echo "hi"', tempDir, controller.signal)).rejects.toThrow(
      'cancelled prior to execution',
    )
  })

  it('should reject when command contains blocked keyword', async () => {
    expect(verify('sudo rm -rf /', tempDir)).rejects.toThrow('blocked_command')
  })
})
