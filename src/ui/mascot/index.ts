import chalk, { type ChalkInstance } from 'chalk'
import { BASE_GRID, OVERLAYS, PALETTE } from './data'

export function frameGrid(name: keyof typeof OVERLAYS): string[] {
  const grid = BASE_GRID.map((row) => row.split(''))
  const overlay = OVERLAYS[name]
  overlay.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const target = grid[overlay.y + y]
      const pixel = row[x]
      if (target && pixel && pixel !== '.') target[overlay.x + x] = pixel
    }
  })
  return grid.map((row) => row.join(''))
}

export function encodeHalfBlock(grid: string[], colors: ChalkInstance = chalk): string {
  const lines: string[] = []
  for (let y = 0; y < grid.length; y += 2) {
    let line = ''
    const row = grid[y] ?? ''
    for (let x = 0; x < row.length; x++) {
      const top = row[x] ?? '.'
      const bottom = grid[y + 1]?.[x] ?? '.'
      if (top === '.' && bottom === '.') line += ' '
      else if (top === bottom) line += colors.hex(PALETTE[top] ?? '#000000')('█')
      else if (bottom === '.') line += colors.hex(PALETTE[top] ?? '#000000')('▀')
      else if (top === '.') line += colors.hex(PALETTE[bottom] ?? '#000000')('▄')
      else line += colors.hex(PALETTE[top] ?? '#000000').bgHex(PALETTE[bottom] ?? '#000000')('▀')
    }
    lines.push(line)
  }
  return lines.join('\n')
}

export function createFrames(colors: ChalkInstance = chalk): string[] {
  return (['dim', 'mid', 'bright', 'mid'] as const).map((name) =>
    encodeHalfBlock(frameGrid(name), colors),
  )
}
