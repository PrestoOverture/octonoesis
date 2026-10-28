import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { editTool } from '../../../src/tools/Edit'
import { readTool } from '../../../src/tools/Read'
import type { ToolContext } from '../../../src/tools/Tool'

describe('Read output bounds', () => {
  let repoRoot: string
  let ctx: ToolContext
  beforeEach(async () => {
    repoRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'read-bounds-')))
    ctx = { repoRoot }
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })
  async function read(content: string | Uint8Array, options = {}) {
    await writeFile(path.join(repoRoot, 'file.txt'), content)
    const input = readTool.inputSchema.parse({ path: 'file.txt', ...options })
    return readTool.call(input, ctx)
  }
  test('pages using 1-based offsets and limits, with a footer for omitted lines', async () => {
    expect(await read('one\ntwo\nthree\nfour', { offset: 2, limit: 2 })).toEqual({
      ok: true,
      value: '2\ttwo\n3\tthree\n[lines 2-3 of 4; use offset to read more]',
    })
    expect(await read('one\ntwo\nthree', { offset: 3 })).toEqual({
      ok: true,
      value: '3\tthree\n[lines 3-3 of 3; use offset to read more]',
    })
    expect(await read('one\ntwo')).toEqual({ ok: true, value: '1\tone\n2\ttwo' })
  })
  test('defaults to 2000 lines', async () => {
    const result = await read(Array.from({ length: 2001 }, (_, i) => `line ${i + 1}`).join('\n'))
    if (!result.ok) throw new Error(result.error)
    expect(result.value).toContain('2000\tline 2000\n')
    expect(result.value).not.toContain('2001\t')
    expect(result.value.endsWith('[lines 1-2000 of 2001; use offset to read more]')).toBe(true)
  })
  test('truncates long lines to 2000 characters and adds the footer', async () => {
    expect(await read('x'.repeat(2500))).toEqual({
      ok: true,
      value: `1\t${'x'.repeat(2000)}\n[lines 1-1 of 1; use offset to read more]`,
    })
  })
  test('caps the entire returned text at 100k characters', async () => {
    for (const count of [50, 100]) {
      const result = await read(Array(count).fill('x'.repeat(2000)).join('\n'))
      if (!result.ok) throw new Error(result.error)
      expect(result.value.length <= 100_000).toBe(true)
      expect(result.value.endsWith(`of ${count}; use offset to read more]`)).toBe(true)
    }
  })
  test('rejects NUL bytes anywhere in the first 8KB, before decoding UTF-8', async () => {
    const bytes = new Uint8Array(8193).fill(120)
    bytes[8191] = 0
    const result = await read(bytes)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('binary')
    bytes[8191] = 120
    bytes[8192] = 0
    expect((await read(bytes)).ok).toBe(true)
  })
  test('records the full file so Edit can change a line omitted by a partial Read', async () => {
    const partial = await read('visible\nhidden', { limit: 1 })
    if (!partial.ok) throw new Error(partial.error)
    expect(partial.value).not.toContain('hidden')
    const result = await editTool.call(
      { path: 'file.txt', old_string: 'hidden', new_string: 'changed' },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(await readFile(path.join(repoRoot, 'file.txt'), 'utf8')).toBe('visible\nchanged')
  })
  test('rejects invalid offset and limit inputs', () => {
    for (const key of ['offset', 'limit']) {
      for (const value of [0, -1, 1.5]) {
        expect(readTool.inputSchema.safeParse({ path: 'file.txt', [key]: value }).success).toBe(
          false,
        )
      }
    }
  })
})
