import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { flushJournal } from '../../src/memory/journal'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../src/permissions/confirm'
import { setProvider } from '../../src/providers'
import type { LLMProvider } from '../../src/providers/types'
import { query } from '../../src/query'
import { bashTool } from '../../src/tools/Bash'
import { runTool } from '../../src/tools/execute'
import { getTool, registerTool, unregisterTool } from '../../src/tools/registry'

describe('Fingerprint Journal Integration', () => {
  const tempDir = join(os.tmpdir(), `octonoesis-fp-integration-${Date.now()}`)
  const journalFile = join(tempDir, 'journal.jsonl')
  let originalMemoryDir: string | undefined
  let originalBashTool = getTool('Bash')

  beforeAll(async () => {
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    process.env.OCTONOESIS_MEMORY_DIR = tempDir
    await rm(tempDir, { recursive: true, force: true })
    await mkdir(tempDir, { recursive: true })

    // Auto-approve command executions in tests
    registerPromptHandler(async () => 'allow_always')
    originalBashTool = getTool('Bash')
    registerTool(bashTool)
  })

  beforeEach(() => {
    clearAllowlist()
  })

  afterAll(async () => {
    if (originalMemoryDir === undefined) {
      Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    await rm(tempDir, { recursive: true, force: true })
    setProvider(null)
    unregisterPromptHandler()
    unregisterTool(bashTool.name, bashTool)
    if (originalBashTool) registerTool(originalBashTool)
  })

  it('should scrub output, extract fingerprint via mock LLM, and log to journal', async () => {
    // 1. Set up a Mock LLM Provider to return a mock JSON response for fingerprinting
    const mockProvider: LLMProvider = {
      name: 'anthropic',
      createMessageStream: async function* () {
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            tool: 'bash-test',
            error_class: 'TypeError',
            file: 'src/buggy.ts',
            expression: "evaluating 'user.name'",
          }),
        }
      },
    }
    setProvider(mockProvider)

    // 2. Run a command that prints an error message to stderr and exits with code 1.
    // repoRoot must be a real directory on whatever machine runs the suite (CI included).
    const repoRoot = process.cwd()
    const command = `echo 'TypeError: null is not an object at ${repoRoot}/src/buggy.ts:7:20' >&2 && exit 1`
    const ctx = { repoRoot }

    const result = await runTool('Bash', { command }, ctx)

    // Command ran successfully from the tool context (even though the shell returned error)
    expect(result.ok).toBe(true)

    // Ensure all journal logs are written to disk
    await flushJournal()

    // 3. Read and parse the journal.jsonl
    const content = await readFile(journalFile, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)

    const permEvent = JSON.parse(lines[0] ?? '')
    expect(permEvent.kind).toBe('permission')

    const event = JSON.parse(lines[1] ?? '')
    expect(event.kind).toBe('tool')
    expect(event.tool).toBe('Bash')
    expect(event.outcome).toBe('success') // Tool completed its execution wrapper successfully

    // 4. Assert that fingerprints are logged correctly in the tool event
    expect(event.fingerprints).toBeDefined()
    expect(event.fingerprints.length).toBe(1)

    const fp = event.fingerprints[0]
    expect(fp.coarse).toBe('bash-test|TypeError')
    expect(fp.medium).toBe('bash-test|TypeError|src/buggy.ts')
    expect(fp.fine).toBe("bash-test|TypeError|src/buggy.ts|evaluating 'user.name'")
  })
})
