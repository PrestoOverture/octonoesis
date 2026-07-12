import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { flushJournal, setSessionId } from '../../src/memory/journal'
import {
  clearAllowlist,
  registerPromptHandler,
  unregisterPromptHandler,
} from '../../src/permissions/confirm'
import type { Tool } from '../../src/tools/Tool'
import { runTool } from '../../src/tools/execute'
import { clearRegistry, getAllTools, registerTool } from '../../src/tools/registry'

describe('sandbox journal metadata', () => {
  let memoryDir: string
  let originalTools: Tool[]

  beforeEach(async () => {
    memoryDir = await mkdtemp(path.join(os.tmpdir(), 'octonoesis-sandbox-journal-'))
    process.env.OCTONOESIS_MEMORY_DIR = memoryDir
    setSessionId('sandbox-journal-session')
    clearAllowlist()
    unregisterPromptHandler()
    originalTools = getAllTools()
    clearRegistry()
    registerTool({
      name: 'Bash',
      description: 'Test Bash boundary',
      inputSchema: z.object({ command: z.string() }),
      isConcurrencySafe: () => false,
      isReadOnly: () => false,
      call: async () => ({
        ok: true as const,
        value: JSON.stringify({ code: 0, stdout: '', stderr: '' }),
      }),
    })
    registerPromptHandler(async () => 'allow_once')
  })

  afterEach(async () => {
    await flushJournal()
    unregisterPromptHandler()
    clearAllowlist()
    clearRegistry()
    for (const tool of originalTools) registerTool(tool)
    setSessionId('')
    process.env.OCTONOESIS_MEMORY_DIR = undefined
    await rm(memoryDir, { recursive: true, force: true })
  })

  it('marks enabled Bash calls true and leaves ordinary Bash calls unmarked', async () => {
    const enabled = await runTool(
      'Bash',
      { command: 'printf enabled' },
      { repoRoot: process.cwd(), sandbox: { enabled: true } },
    )
    const disabled = await runTool(
      'Bash',
      { command: 'printf disabled' },
      { repoRoot: process.cwd() },
    )
    expect(enabled.ok).toBe(true)
    expect(disabled.ok).toBe(true)

    await flushJournal()
    const events = (await readFile(path.join(memoryDir, 'journal.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.kind === 'tool')

    expect(events.length).toBe(2)
    expect(events[0].sandboxed).toBe(true)
    expect(events[1].sandboxed).toBeUndefined()
  })
})
