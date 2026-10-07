import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Chalk } from 'chalk'
import { createFrames, encodeHalfBlock, frameGrid } from '../../../src/ui/mascot'
import {
  BASE_GRID,
  COMPACT_BASE_GRID,
  COMPACT_OVERLAYS,
  OVERLAYS,
  PALETTE,
} from '../../../src/ui/mascot/data'

const colors = new Chalk({ level: 3 })
test('frozen f11 grid and overlays', () => {
  expect(BASE_GRID.length).toBe(33)
  expect(BASE_GRID.every((row) => row.length === 33)).toBe(true)
  expect(createHash('sha256').update(BASE_GRID.join('\n')).digest('hex')).toBe(
    '419577d8f6adc81b41ed3a0c60a675abd7a602ce4806345596a01ff70ba46587',
  )
  expect(OVERLAYS).toEqual({
    dim: { x: 13, y: 11, rows: ['...b...', '..bgb..', '...b...'] },
    mid: { x: 13, y: 11, rows: ['..bGb..', 'bgGAGgb', '..bGb..'] },
    bright: { x: 13, y: 10, rows: ['..bbb..', '.bgGgb.', 'bgGAGgb', '.bgGgb.', '..bbb..'] },
  })
  const before = frameGrid('dim')
  frameGrid('bright')
  expect(frameGrid('dim')).toEqual(before)
})
test('all five half-block cases and odd final row, including background reset', () => {
  expect(encodeHalfBlock(['.', '.'], colors)).toBe(' ')
  expect(encodeHalfBlock(['B', 'B'], colors)).toBe(colors.bgHex('#E9F2FF')(' '))
  expect(encodeHalfBlock(['d', 't'], colors)).toBe(colors.bgHex('#5F7699')(' '))
  expect(encodeHalfBlock(['B', '.'], colors)).toBe(colors.hex('#E9F2FF')('▀'))
  expect(encodeHalfBlock(['.', 'B'], colors)).toBe(colors.hex('#E9F2FF')('▄'))
  expect(encodeHalfBlock(['B', 'b'], colors)).toBe(colors.hex('#C9D6EA').bgHex('#E9F2FF')('▄'))
  expect(encodeHalfBlock(['B'], colors)).toBe(colors.hex('#E9F2FF')('▀'))
  expect(encodeHalfBlock(['B', 'b'], colors)).toContain('\x1b[49m')
  expect(encodeHalfBlock(['B'], colors).endsWith('\x1b[39m')).toBe(true)
})
test('exactly four precomputed frames differ only on third-eye lines, and chalk downgrades', () => {
  const frames = createFrames(colors)
  expect(frames.length).toBe(4)
  expect(frames[1]).toBe(frames[3])
  expect(new Set(frames).size).toBe(3)
  for (let index = 0; index < frames.length; index++) {
    const a = frames[index]?.split('\n') ?? []
    const b = frames[(index + 1) % 4]?.split('\n') ?? []
    expect(a.length).toBe(17)
    for (let line = 0; line < a.length; line++)
      if (a[line] !== b[line]) expect([5, 6, 7]).toContain(line)
  }
  expect(createFrames(new Chalk({ level: 2 }))[0]).toContain('\x1b[38;5;')
  expect(createFrames(new Chalk({ level: 1 }))[0]).not.toContain('[38;2;')
  expect(PALETTE).toEqual({
    B: '#E9F2FF',
    b: '#C9D6EA',
    d: '#5F7699',
    g: '#8FDDE6',
    G: '#3FC9D9',
    A: '#E6FFFF',
    T: '#8FA6C8',
    t: '#5F7699',
    o: '#5F7699',
    n: '#FFE7A8',
    N: '#FFC857',
  })
})

test('compact frozen grid, overlays and four seam-free frames', () => {
  expect(COMPACT_BASE_GRID.length).toBe(17)
  expect(COMPACT_BASE_GRID.every((row) => row.length === 17)).toBe(true)
  expect(createHash('sha256').update(COMPACT_BASE_GRID.join('\n')).digest('hex')).toBe(
    'ba544d365f149691e2e8643a237d2ef7ca2e3bd041efcd7e49c8b5530ca1f9ac',
  )
  expect(COMPACT_OVERLAYS).toEqual({
    dim: { x: 8, y: 6, rows: ['g'] },
    mid: { x: 7, y: 6, rows: ['gGg'] },
    bright: { x: 7, y: 5, rows: ['.b.', 'gGg', '.b.'] },
  })
  for (const name of ['dim', 'mid', 'bright'] as const) {
    const grid = frameGrid(name, true)
    const overlay = COMPACT_OVERLAYS[name]
    for (let y = 0; y < 17; y++) {
      for (let x = 0; x < 17; x++) {
        const pixel = overlay.rows[y - overlay.y]?.[x - overlay.x]
        expect(grid[y]?.[x]).toBe(pixel && pixel !== '.' ? pixel : COMPACT_BASE_GRID[y]?.[x])
      }
    }
  }
  const frames = createFrames(colors, true)
  expect(frames).toEqual(
    ['dim', 'mid', 'bright', 'mid'].map((name) =>
      encodeHalfBlock(frameGrid(name as keyof typeof COMPACT_OVERLAYS, true), colors),
    ),
  )
  expect(frames.length).toBe(4)
  expect(frames[1]).toBe(frames[3])
  expect(new Set(frames).size).toBe(3)
  for (let index = 0; index < 4; index++) {
    const lines = frames[index]?.split('\n') ?? []
    expect(lines.length).toBe(9)
    const next = frames[(index + 1) % 4]?.split('\n') ?? []
    expect(lines.some((line, y) => line !== next[y])).toBe(true)
    lines.forEach((line, y) => {
      if (line !== next[y]) expect([2, 3]).toContain(y)
    })
  }
  for (const frame of [...frames, ...createFrames(colors)]) expect(frame).not.toContain('█')
})
