import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushJournal } from '../../../src/memory/journal'
import { registerPromptHandler, unregisterPromptHandler } from '../../../src/permissions/confirm'
import { editTool } from '../../../src/tools/Edit'
import { readTool } from '../../../src/tools/Read'
import type { Tool } from '../../../src/tools/Tool'
import { writeTool } from '../../../src/tools/Write'
import { runTool } from '../../../src/tools/execute'
import { registerTool } from '../../../src/tools/registry'
import { restoreEnv } from '../../helpers/env'
import { restoreRegistry, snapshotRegistry } from '../../helpers/globalState'

let directory: string
let memoryDir: string
let previousMemoryDir: string | undefined
let tools: Tool[]

beforeEach(async () => {
  tools = snapshotRegistry()
  previousMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  directory = await realpath(await mkdtemp(join(tmpdir(), 'evidence-redaction-')))
  memoryDir = join(directory, 'ledger')
  process.env.OCTONOESIS_MEMORY_DIR = memoryDir
  registerTool(writeTool)
  registerTool(editTool)
  registerPromptHandler(async () => 'allow_once')
})

afterEach(async () => {
  await flushJournal()
  unregisterPromptHandler()
  restoreRegistry(tools)
  restoreEnv('OCTONOESIS_MEMORY_DIR', previousMemoryDir)
  await rm(directory, { recursive: true, force: true })
})

for (const operation of ['Write', 'Edit'] as const) {
  test(`${operation} evidence redacts secrets before persistence in the journal`, async () => {
    const oldSecret = 'sk-proj-syntheticOldCredentialForRedactionOnly'
    const newSecret = 'sk-proj-syntheticNewCredentialForRedactionOnly'
    const opaqueToken = 'synthetic-opaque-credential-for-redaction-only'
    const ctx = { repoRoot: directory }
    const oldText = `API_KEY="${oldSecret}"\n`
    const newText = `API_KEY="${newSecret}"\nSERVICE_TOKEN=${opaqueToken}\n`
    if (operation === 'Edit') {
      await writeFile(join(directory, '.env'), oldText)
      expect((await readTool.call({ path: '.env' }, ctx)).ok).toBe(true)
    }
    const input =
      operation === 'Write'
        ? { path: '.env', content: newText }
        : { path: '.env', old_string: oldText, new_string: newText }
    expect((await runTool(operation, input, ctx)).ok).toBe(true)
    // Only persisted learning evidence is redacted; the requested file write stays exact.
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe(newText)
    await flushJournal()
    const journal = await readFile(join(memoryDir, 'journal.jsonl'), 'utf8')
    for (const secret of [oldSecret, newSecret, opaqueToken]) expect(journal).not.toContain(secret)
    const entry = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.fix_diff !== undefined)
    expect(entry.fix_diff).toContain('[REDACTED]')
    expect(entry.fix_diff).toContain('API_KEY=')
  })
}

test('Write evidence scrubs a token crossing the evidence truncation boundary', async () => {
  const token = `sk-proj-${'q'.repeat(200)}`
  const content = `${'x'.repeat(11950)}\n${token}`
  expect((await runTool('Write', { path: '.env', content }, { repoRoot: directory })).ok).toBe(true)
  await flushJournal()
  const journal = await readFile(join(memoryDir, 'journal.jsonl'), 'utf8')
  expect(journal).not.toContain('sk-proj-')
  expect(
    journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.fix_diff !== undefined).fix_diff,
  ).toContain('[REDACTED]')
})
