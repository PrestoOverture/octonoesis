declare const Bun: { stringWidth(text: string): number }
import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import chalk from 'chalk'
import { render } from 'ink'
import React from 'react'
import { parseConfig } from '../../../src/config/schema'
import { requestPermission } from '../../../src/permissions/confirm'
import { setProvider } from '../../../src/providers'
import { getTodos, setTodos } from '../../../src/state/todos'
import { App } from '../../../src/ui/App'
import { bannerLayout, version } from '../../../src/ui/banner'
import { prepareScreenSequence } from '../../../src/ui/screen'
import { restoreEnv } from '../../helpers/env'

async function waitFor(predicate: () => boolean, timeout = 3000) {
  const started = performance.now()
  while (!predicate() && performance.now() - started < timeout) await delay(20)
  expect(predicate()).toBe(true)
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function terminal(
  options: {
    prepare?: (directory: string) => Promise<void>
    rows?: number
    columns?: number
    tty?: boolean
    animation?: 'off' | 'on'
    resume?: boolean
    levelZero?: boolean
    noColor?: boolean
    envOff?: boolean
  } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'noe-banner-'))
  await options.prepare?.(directory)
  const env = {
    OCTONOESIS_MEMORY_DIR: directory,
    OCTONOESIS_DISABLE_MEMORY: '1',
    OCTONOESIS_DISABLE_COMPACT: '1',
    NO_COLOR: options.noColor ? '1' : undefined,
    OCTONOESIS_NO_ANIMATION: options.envOff ? '1' : undefined,
  }
  const originals = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) restoreEnv(key, value)
  const level = chalk.level
  chalk.level = options.levelZero ? 0 : 3
  const chunks: string[] = []
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString())
        callback()
      },
    }),
    { isTTY: options.tty ?? true, rows: options.rows ?? 40, columns: options.columns ?? 100 },
  )
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  const view = render(
    <App
      ctx={{
        repoRoot: directory,
        memoryDir: directory,
        config: parseConfig({ ui: { animation: options.animation ?? 'on' } }),
        messages: options.resume ? [{ role: 'user', content: 'resumed-history' }] : [],
      }}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      interactive: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  return {
    chunks,
    stdin,
    stdout,
    async close() {
      view.unmount()
      chalk.level = level
      setProvider(null)
      for (const [key, value] of Object.entries(originals)) restoreEnv(key, value)
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}
function normalized(output: string) {
  return stripVTControlCharacters(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
}
function noClears(output: string) {
  expect(output).not.toContain('\x1b[2J')
  expect(output).not.toContain('\x1b[3J')
}
test('breathes for two seconds, commits once, spinner counts seconds and disappears', async () => {
  const tty = await terminal({ columns: 80, rows: 24 })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      await gate
      yield { type: 'text_delta', text: 'reply-done' }
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  try {
    await waitFor(() => tty.chunks.some((chunk) => chunk.includes('Usage:')))
    await delay(2000)
    const paints = tty.chunks.filter((chunk) => chunk.includes('Noe ·'))
    const eyes = new Set(paints.map((paint) => paint.split('\n').slice(2, 4).join('\n')))
    expect(eyes.size).toBeGreaterThan(2)
    tty.stdin.write('hello')
    await delay(40)
    const start = tty.chunks.length
    tty.stdin.write('\r')
    await delay(1350)
    const afterSubmit = tty.chunks.slice(start).join('')
    expect(afterSubmit.split(`Noe · Octonoesis v${version}`).length - 1).toBe(1)
    // The frozen mid glow has its cyan core background, with no bright halo above it.
    expect(afterSubmit).toContain('\x1b[48;2;63;201;217m')
    const frozen = tty.chunks.slice(start).find((chunk) => chunk.includes('Noe ·')) ?? ''
    expect(frozen.split('\n')[2] ?? '').not.toContain('\x1b[38;2;201;214;234m')
    expect(afterSubmit).toContain('1s · ctrl+c to interrupt')
    const committed = tty.chunks.length
    await delay(500)
    expect(/[▀▄█]/.test(tty.chunks.slice(committed).join(''))).toBe(false)
    release()
    await delay(250)
    const completed = tty.chunks.join('')
    expect(completed.slice(completed.lastIndexOf('\x1b[G'))).not.toContain('ctrl+c to interrupt')
    noClears(tty.chunks.join(''))
  } finally {
    release()
    await tty.close()
  }
})
for (const [name, options] of Object.entries({
  NO_COLOR: { noColor: true },
  'chalk level zero': { levelZero: true },
  'animation off': { animation: 'off' as const },
  'environment off': { envOff: true },
  'short terminal': { rows: 14 },
  'narrow terminal': { columns: 30 },
  'resumed session': { resume: true },
  'non-TTY': { tty: false },
})) {
  test(`${name}: static banner with no timer writes`, async () => {
    const tty = await terminal(options)
    try {
      await waitFor(() => tty.chunks.some((chunk) => chunk.includes('Usage:')))
      await delay(100)
      const before = tty.chunks.length
      await delay(1000)
      expect(tty.chunks.length).toBe(before)
      const output = tty.chunks.join('')
      expect(output).toContain(`Noe · Octonoesis v${version}`)
      if (options.resume) expect(output.split(`Noe · Octonoesis v${version}`).length - 1).toBe(1)
      expect(tty.chunks.filter((chunk) => /[▀▄█]/.test(chunk)).length).toBeLessThan(2)
      if (options.noColor || options.levelZero || options.rows || options.columns)
        expect(/[▀▄█]/.test(output)).toBe(false)
      if (options.resume)
        expect(output.indexOf('Noe')).toBeLessThan(output.indexOf('resumed-history'))
      noClears(output)
    } finally {
      await tty.close()
    }
  })
}
test('layout thresholds and strict animation config', () => {
  expect(bannerLayout(76, 40, 7, true)).toBe('beside')
  expect(bannerLayout(59, 40, 7, true)).toBe('above')
  expect(bannerLayout(60, 40, 7, true)).toBe('beside')
  expect(bannerLayout(39, 40, 7, true)).toBe('text')
  expect(bannerLayout(100, 14, 7, true)).toBe('text')
  expect(bannerLayout(100, 40, 7, false)).toBe('text')
  expect(parseConfig({}).ui.animation).toBe('on')
  expect(() => parseConfig({ ui: { animation: 'auto' } })).toThrow()
  expect(() => parseConfig({ ui: { animations: 'off' } })).toThrow()
})

test('five-minute idle freezes mid, keypress restarts, unmount cancels writes', async () => {
  const originalNow = Date.now
  let offset = 0
  Date.now = () => originalNow() + offset
  const tty = await terminal()
  try {
    await delay(100)
    offset = 300001
    await delay(500)
    const idle = tty.chunks.length
    await delay(500)
    expect(tty.chunks.length).toBe(idle)
    tty.stdin.write('a')
    await delay(100)
    const keyed = tty.chunks.length
    await delay(950)
    expect(tty.chunks.length).toBeGreaterThan(keyed)
    await tty.close()
    const closed = tty.chunks.length
    await delay(500)
    expect(tty.chunks.length).toBe(closed)
  } finally {
    Date.now = originalNow
    await tty.close()
  }
})

test('permission prompt hides the generating spinner without clears', async () => {
  const tty = await terminal({ rows: 24 })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      await gate
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  try {
    await delay(50)
    tty.stdin.write('hello')
    await delay(40)
    tty.stdin.write('\r')
    await delay(200)
    expect(tty.chunks.join('')).toContain('Contemplating')
    const prompted = tty.chunks.length
    const answer = requestPermission('Write', { path: 'test', content: 'test' })
    await delay(150)
    expect(tty.chunks.slice(prompted).join('')).not.toContain('Contemplating')
    const waiting = tty.chunks.length
    await delay(250)
    expect(tty.chunks.length).toBe(waiting)
    const dismissed = tty.chunks.length
    tty.stdin.write('n')
    expect(await answer).toBe('deny')
    await delay(150)
    expect(tty.chunks.slice(dismissed).join('')).toContain('Contemplating')
    noClears(tty.chunks.join(''))
  } finally {
    release()
    await delay(100)
    await tty.close()
  }
})

test('ledger fixture loads after first paint and appears in the banner', async () => {
  const tty = await terminal({
    animation: 'off',
    async prepare(directory) {
      await fs.writeFile(
        path.join(directory, 'episodes.jsonl'),
        JSON.stringify({
          id: 'ep_fixture',
          timestamp: new Date().toISOString(),
          session_id: 'fixture',
          task_digest: 'fixture',
          failure: { tool: 'Bash', cmd: 'test', error_class: 'test', signature: 'test' },
          fix_candidates: [],
          attribution: { status: 'unattributable', confidence: 0 },
          outcome: 'abandoned',
          journal_line_range: { start: 1, end: 1 },
          value_score: 0,
          is_excluded: false,
          exclusion_reason: null,
        }),
      )
    },
  })
  try {
    await delay(200)
    const paints = tty.chunks.filter((chunk) => chunk.includes('Noe ·'))
    expect(paints[0]).not.toContain('active rules')
    expect(tty.chunks.join('')).toContain('0 active rules · 1 episodes')
    noClears(tty.chunks.join(''))
  } finally {
    await tty.close()
  }
})

test('resize immediately bounds banner frames to the live terminal width', async () => {
  const tty = await terminal()
  try {
    await delay(100)
    for (const [columns, rows, mascot] of [
      [70, 40, true],
      [30, 40, false],
      [100, 14, false],
      [100, 40, true],
      [60, 30, true],
      [45, 30, true],
    ] as const) {
      const start = tty.chunks.length
      tty.stdout.columns = columns
      tty.stdout.rows = rows
      tty.stdout.emit('resize')
      await delay(550)
      const output = tty.chunks.slice(start).join('')
      const lines = normalized(output).split('\n')
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThan(columns)
      const frame = output.slice(output.lastIndexOf('\x1b[G'))
      expect(/[▀▄█]/.test(frame)).toBe(mascot)
      const titleLine = normalized(frame)
        .split('\n')
        .findIndex((line) => line.includes('Noe ·'))
      if (columns === 45) expect(titleLine).toBe(9)
      else expect(titleLine).toBe(0)
      expect(output).not.toContain('\x1b[3J')
    }
  } finally {
    await tty.close()
  }
})

test('resize bursts scroll once, then redraw a full frame without destructive clears', async () => {
  const tty = await terminal({ animation: 'off' })
  try {
    await delay(100)
    for (const burst of [
      [[50, 40]],
      [[100, 40]],
      [[100, 22]],
      [
        [100, 40],
        [60, 30],
        [45, 30],
      ],
    ]) {
      const start = tty.chunks.length
      for (const dimensions of burst) {
        tty.stdout.columns = dimensions[0] ?? 100
        tty.stdout.rows = dimensions[1] ?? 40
        tty.stdout.emit('resize')
        await delay(30)
      }
      expect(tty.chunks.slice(start).join('')).not.toContain('\x1b[H\x1b[0J')
      await delay(250)
      const output = tty.chunks.slice(start).join('')
      const sequence = prepareScreenSequence(tty.stdout.rows)
      expect(output.split(sequence).length - 1).toBe(1)
      const redraw = normalized(output.slice(output.indexOf(sequence) + sequence.length))
      expect(redraw.split('Noe · Octonoesis').length - 1).toBe(1)
      expect(redraw).toContain('Type a message...')
      expect(redraw).toContain('Model:')
      noClears(output)
    }
    const before = tty.chunks.length
    await delay(250)
    expect(tty.chunks.length).toBe(before)
  } finally {
    await tty.close()
  }
})

test('conversation resize redraws only the dynamic region and cancels reset on unmount', async () => {
  const previousTodos = getTodos()
  setTodos([])
  const tty = await terminal()
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield {
        type: 'text_delta',
        text: `committed-resize-reply\n\n${Array.from({ length: 60 }, (_, index) => `streaming-resize-${index}`).join('\n')}`,
      }
      await gate
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  try {
    await delay(100)
    tty.stdin.write('resize conversation')
    await delay(40)
    tty.stdin.write('\r')
    await delay(250)
    const start = tty.chunks.length
    tty.stdout.rows = 20
    tty.stdout.columns = 45
    tty.stdout.emit('resize')
    await delay(300)
    const output = tty.chunks.slice(start).join('')
    const sequence = prepareScreenSequence(20)
    expect(output.split(sequence).length - 1).toBe(1)
    const redraw = output.slice(output.indexOf(sequence) + sequence.length)
    expect(output).not.toContain('committed-resize-reply')
    expect(redraw).toContain('streaming-resize-59')
    expect(redraw).not.toContain('Noe ·')
    expect(redraw).toContain('ctrl+c to interrupt')
    expect(redraw).toContain('Type a message...')
    expect(redraw).toContain('Model:')
    noClears(output)
    release()
    await delay(100)
    tty.stdout.emit('resize')
    await tty.close()
    const closed = tty.chunks.length
    await delay(250)
    expect(tty.chunks.length).toBe(closed)
  } finally {
    release()
    await tty.close()
    setTodos(previousTodos)
  }
})

for (const columns of [91, 60]) {
  test(`CJK streaming and permission borders stay inside the parent at ${columns}x24`, async () => {
    const tty = await terminal({ columns, rows: 24, animation: 'off' })
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setProvider({
      name: 'anthropic',
      async *createMessageStream() {
        yield { type: 'text_delta', text: '终端显示宽度必须正确。'.repeat(80) }
        await gate
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    })
    const check = (chunks: string[]) => {
      for (const chunk of chunks) {
        for (const line of stripVTControlCharacters(chunk).split('\n')) {
          expect(Bun.stringWidth(line)).toBeLessThan(columns)
          if (line.includes('│')) {
            expect(line.split('│').length).toBe(3)
            expect(line.trimEnd().endsWith('│')).toBe(true)
          }
        }
      }
    }
    try {
      await delay(100)
      tty.stdin.write('hello')
      await delay(40)
      tty.stdin.write('\r')
      await delay(200)
      check(tty.chunks)
      expect(normalized(tty.chunks.join(''))).toContain('终端')
      const start = tty.chunks.length
      const permission = requestPermission('Write', {
        path: '测试.txt',
        content: '内容'.repeat(150),
      })
      await delay(200)
      const prompt = tty.chunks.slice(start)
      check(prompt)
      noClears(tty.chunks.join(''))
      const output = normalized(prompt.join(''))
      expect(output).toContain('[Permission Required]')
      expect(output).toContain('Model:')
      expect(output).toContain('cost:')
      expect(output).toContain('╭')
      expect(output).toContain('╮')
      expect(output).toContain('╰')
      expect(output).toContain('╯')
      expect(output).toContain('┌')
      expect(output).toContain('┐')
      expect(output).toContain('└')
      expect(output).toContain('┘')
      tty.stdin.write('n')
      await permission
    } finally {
      release()
      await delay(50)
      await tty.close()
    }
  })
}
test('TUI chrome uses no variation-selector or pictographic emoji', async () => {
  const directory = path.join(import.meta.dir, '../../../src/ui')
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.tsx')) continue
    const source = await fs.readFile(path.join(directory, name), 'utf8')
    expect(/[\u{1f300}-\u{1faff}]|\ufe0f/u.test(source)).toBe(false)
  }
})

for (const [columns, rows, layout] of [
  [80, 24, 'beside'],
  [91, 24, 'beside'],
  [60, 24, 'beside'],
  [45, 30, 'above'],
  [40, 48, 'above'],
  [30, 40, 'text'],
  [100, 14, 'text'],
] as const) {
  test(`compact layout ${columns}x${rows}: ${layout}, bounded dynamic frames`, async () => {
    const tty = await terminal({ columns, rows })
    try {
      await waitFor(() => tty.chunks.some((chunk) => chunk.includes('Usage:')))
      if (layout !== 'text') {
        await waitFor(
          () => new Set(tty.chunks.filter((chunk) => chunk.includes('Noe ·'))).size >= 3,
          2000,
        )
      }
      const paints = tty.chunks.filter((chunk) => chunk.includes('Noe ·'))
      for (const paint of paints) {
        const lines = normalized(paint).trimEnd().split('\n')
        expect(lines.length).toBeLessThan(rows)
        for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThan(columns)
        expect(/[▀▄]/.test(paint)).toBe(layout !== 'text')
        const titleRow = lines.findIndex((line) => line.includes('Noe ·'))
        expect(titleRow).toBe(layout === 'above' ? 9 : 0)
        if (layout === 'beside') expect(lines[0]?.indexOf('Noe ·')).toBe(19)
      }
      noClears(tty.chunks.join(''))
    } finally {
      await tty.close()
    }
  })
}

test('measured multiline input makes a boundary-height banner fall back to text', async () => {
  const tty = await terminal({ columns: 40, rows: 24, animation: 'off' })
  try {
    await waitFor(() => tty.chunks.some((chunk) => chunk.includes('Noe ·') && /[▀▄]/.test(chunk)))
    const start = tty.chunks.length
    tty.stdin.write('first\\')
    await waitFor(() => tty.chunks.slice(start).some((chunk) => chunk.includes('first')))
    tty.stdin.write('\r')
    await waitFor(() =>
      tty.chunks.slice(start).some((chunk) => chunk.includes('Noe ·') && !/[▀▄]/.test(chunk)),
    )
    for (const paint of tty.chunks.filter((chunk) => chunk.includes('Noe ·'))) {
      expect(normalized(paint).trimEnd().split('\n').length).toBeLessThan(24)
    }
    noClears(tty.chunks.join(''))
  } finally {
    await tty.close()
  }
})
