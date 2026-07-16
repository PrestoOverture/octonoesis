import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  appendInputHistory,
  createInputHistoryCursor,
  getInputHistoryPath,
  loadInputHistory,
  navigateInputHistory,
} from '../../../src/ui/inputHistory.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempMemoryDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-input-history-'))
  tempDirs.push(dir)
  return dir
}

describe('input history', () => {
  it('appends submissions while suppressing only consecutive duplicates', async () => {
    const memoryDir = await tempMemoryDir()
    await appendInputHistory(memoryDir, 'alpha', {
      now: new Date('2026-07-17T01:00:00.000Z'),
    })
    await appendInputHistory(memoryDir, 'alpha', {
      now: new Date('2026-07-17T01:01:00.000Z'),
    })
    await appendInputHistory(memoryDir, 'beta', {
      now: new Date('2026-07-17T01:02:00.000Z'),
    })
    await appendInputHistory(memoryDir, 'alpha', {
      now: new Date('2026-07-17T01:03:00.000Z'),
    })

    const entries = await loadInputHistory(memoryDir)

    expect(entries.map((entry) => entry.text)).toEqual(['alpha', 'beta', 'alpha'])
    expect(
      (await fs.readFile(getInputHistoryPath(memoryDir), 'utf8')).trim().split('\n').length,
    ).toBe(3)
  })

  it('loads the newest 500 and compacts the file after it grows past 1,000', async () => {
    const memoryDir = await tempMemoryDir()
    const historyPath = getInputHistoryPath(memoryDir)
    const initial = Array.from({ length: 1_000 }, (_, index) =>
      JSON.stringify({
        ts: `2026-07-17T01:${index.toString().padStart(4, '0')}Z`,
        text: `entry-${index}`,
      }),
    )
    await fs.writeFile(historyPath, `${initial.join('\n')}\n`)

    expect((await loadInputHistory(memoryDir)).map((entry) => entry.text)[0]).toBe('entry-500')
    await appendInputHistory(memoryDir, 'entry-1000', {
      now: new Date('2026-07-17T02:00:00.000Z'),
    })

    const loaded = await loadInputHistory(memoryDir)
    const lines = (await fs.readFile(historyPath, 'utf8')).trim().split('\n')
    expect(loaded.length).toBe(500)
    expect(loaded[0]?.text).toBe('entry-501')
    expect(loaded[499]?.text).toBe('entry-1000')
    expect(lines.length).toBe(500)
  })

  it('stashes and restores a draft while never replacing a multiline buffer', () => {
    const entries = ['old prompt', 'new prompt']
    const initial = createInputHistoryCursor()
    const newest = navigateInputHistory(entries, initial, 'older', 'work in progress')
    expect(newest).toEqual({
      value: 'new prompt',
      cursor: { index: 1, draft: 'work in progress' },
    })
    const oldest = navigateInputHistory(entries, newest.cursor, 'older', newest.value)
    expect(oldest).toEqual({
      value: 'old prompt',
      cursor: { index: 0, draft: 'work in progress' },
    })
    const newer = navigateInputHistory(entries, oldest.cursor, 'newer', oldest.value)
    expect(newer.value).toBe('new prompt')
    const restored = navigateInputHistory(entries, newer.cursor, 'newer', newer.value)
    expect(restored).toEqual({
      value: 'work in progress',
      cursor: { index: null, draft: '' },
    })

    expect(navigateInputHistory(entries, initial, 'older', 'line one\nline two')).toEqual({
      value: 'line one\nline two',
      cursor: initial,
    })
  })

  it('serializes concurrent appends so consecutive duplicates remain one row', async () => {
    const memoryDir = await tempMemoryDir()

    await Promise.all([
      appendInputHistory(memoryDir, 'same concurrent prompt', {
        now: new Date('2026-07-17T03:00:00.000Z'),
      }),
      appendInputHistory(memoryDir, 'same concurrent prompt', {
        now: new Date('2026-07-17T03:00:01.000Z'),
      }),
    ])

    expect((await loadInputHistory(memoryDir)).map((entry) => entry.text)).toEqual([
      'same concurrent prompt',
    ])
  })
})
