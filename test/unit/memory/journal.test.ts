import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tempDir = path.join(os.tmpdir(), `octonoesis-journal-test-${Date.now()}`)

import {
  appendJournal,
  flushJournal,
  getSessionId,
  setSessionId,
} from '../../../src/memory/journal'

describe('Journal Writer Storage', () => {
  let originalMemoryDir: string | undefined

  beforeAll(async () => {
    originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    process.env.OCTONOESIS_MEMORY_DIR = tempDir
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterAll(async () => {
    if (originalMemoryDir === undefined) {
      process.env.OCTONOESIS_MEMORY_DIR = undefined
    } else {
      process.env.OCTONOESIS_MEMORY_DIR = originalMemoryDir
    }
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('manages session id binding', () => {
    setSessionId('test-session-123')
    expect(getSessionId()).toBe('test-session-123')
  })

  test('appends events in order and creates directory structure', async () => {
    const event1 = {
      kind: 'turn' as const,
      turn: 1,
    }
    const event2 = {
      kind: 'turn' as const,
      turn: 2,
    }

    appendJournal(event1)
    appendJournal(event2)

    await flushJournal()

    const journalFile = path.join(tempDir, 'journal.jsonl')
    const fileExists = await fs
      .stat(journalFile)
      .then(() => true)
      .catch(() => false)
    expect(fileExists).toBe(true)

    const content = await fs.readFile(journalFile, 'utf8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)

    const parsed1 = JSON.parse(lines[0] || '')
    const parsed2 = JSON.parse(lines[1] || '')

    expect(parsed1.kind).toBe('turn')
    expect(parsed1.turn).toBe(1)
    expect(parsed1.session_id).toBe('test-session-123')
    expect(parsed1.ts).toBeDefined()

    expect(parsed2.kind).toBe('turn')
    expect(parsed2.turn).toBe(2)
  })
})
