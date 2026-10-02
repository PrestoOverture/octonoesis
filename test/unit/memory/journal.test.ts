import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tempDir = path.join(os.tmpdir(), `octonoesis-journal-test-${Date.now()}`)

import {
  appendJournal,
  flushJournal,
  formatJournalFailureNotice,
  getJournalWriteFailureCount,
  getSessionId,
  resetJournalWriteFailures,
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
      Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
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

  test('reports write failures once and recovers the queue for later writes', async () => {
    const previousMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
    const blocker = path.join(tempDir, 'regular-file')
    const failedDir = path.join(blocker, 'memory')
    const failedPath = path.join(failedDir, 'journal.jsonl')
    const recoveryDir = path.join(tempDir, 'recovery')
    const originalError = console.error
    const errorCalls: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errorCalls.push(args)
    }
    resetJournalWriteFailures()
    try {
      expect(formatJournalFailureNotice()).toBeUndefined()
      await fs.writeFile(blocker, 'not a directory')
      process.env.OCTONOESIS_MEMORY_DIR = failedDir
      for (let turn = 1; turn <= 3; turn++) appendJournal({ kind: 'turn', turn })
      await flushJournal()

      expect(errorCalls.length).toBe(1)
      expect(errorCalls[0]?.[0]).toContain(failedPath)
      expect(errorCalls[0]?.[0]).toContain('ENOTDIR')
      expect(getJournalWriteFailureCount()).toBe(3)
      expect(formatJournalFailureNotice()).toBe(
        '⚠ Ledger incomplete: 3 journal write(s) failed this session (last: ENOTDIR)',
      )

      process.env.OCTONOESIS_MEMORY_DIR = recoveryDir
      appendJournal({ kind: 'turn', turn: 4 })
      await flushJournal()
      const line = await fs.readFile(path.join(recoveryDir, 'journal.jsonl'), 'utf8')
      expect(JSON.parse(line).turn).toBe(4)
      expect(getJournalWriteFailureCount()).toBe(3)
    } finally {
      await flushJournal()
      if (previousMemoryDir === undefined) {
        Reflect.deleteProperty(process.env, 'OCTONOESIS_MEMORY_DIR')
      } else {
        process.env.OCTONOESIS_MEMORY_DIR = previousMemoryDir
      }
      resetJournalWriteFailures()
      console.error = originalError
    }
  })
})
