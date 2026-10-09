declare const Bun: { stringWidth(text: string): number }
import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters as strip } from 'node:util'
import chalk from 'chalk'
import { render } from 'ink'
import React from 'react'
import { flushJournal } from '../../../src/memory/journal'
import { requestPermission } from '../../../src/permissions/confirm'
import { setProvider } from '../../../src/providers'
import type { CanonicalMessage } from '../../../src/query'
import { App } from '../../../src/ui/App'
import { restoreEnv } from '../../helpers/env'

const RESIZE_CLEAR = '\x1b[2J\x1b[3J\x1b[H'

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Missing terminal frame')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// Small screen model for the cursor/erase operations Ink emits. Keep scrollback
// too: duplicate chrome above the live frame must not be hidden by assertions.
class Screen {
  lines: string[] = ['']
  row = 0
  column = 0
  home = 0
  cursorUnderflows = 0
  constructor(public rows: number) {}
  feed(output: string) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: parse terminal control bytes
    for (const token of output.match(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]/gu) ?? []) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: parse terminal control bytes
      const csi = /^\x1b\[([\d;?]*)(.)$/.exec(token)
      if (csi) {
        const n = Number(csi[1]) || 1
        switch (csi[2]) {
          case 'A':
            if (this.row - n < this.home) this.cursorUnderflows++
            this.row = Math.max(this.home, this.row - n)
            break
          case 'B':
            this.row += n
            break
          case 'G':
            this.column = n - 1
            break
          case 'H':
            this.row = this.home
            this.column = 0
            break
          case 'J':
            if (csi[1] === '3') {
              this.lines = this.lines.slice(this.home)
              this.row -= this.home
              this.home = 0
              this.cursorUnderflows = 0
            } else if (csi[1] === '2') this.lines.length = this.home
            else this.lines.length = this.row + 1
            break
          case 'K':
            this.lines[this.row] = ''
            break
        }
        continue
      }
      if (token === '\n') {
        this.row++
        this.column = 0
      } else if (token === '\r') this.column = 0
      else {
        const line = this.lines[this.row] ?? ''
        this.lines[this.row] =
          line.padEnd(this.column).slice(0, this.column) + token + line.slice(this.column + 1)
        this.column++
      }
      this.home = Math.max(this.home, this.row - this.rows + 1)
    }
  }
  get visible() {
    return Array.from({ length: this.rows }, (_, i) => this.lines[this.home + i] ?? '')
  }
}

const messages: CanonicalMessage[] = [
  { role: 'user', content: 'first-resize-message' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { path: 'src/example.ts' } }],
  },
  { role: 'tool', tool_use_id: 'read', content: '1\tfirst\n2\tsecond' },
  { role: 'user', content: 'second-resize-message' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: `resize-reply ${'words to reflow at the new width '.repeat(5)}` },
    ],
  },
]

async function terminal(
  history: CanonicalMessage[] = messages,
  options: { tty?: boolean; ci?: boolean; color?: boolean } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resize-reprint-'))
  const level = chalk.level
  if (options.color) chalk.level = 3
  const env = {
    NO_COLOR: undefined,
    CI: options.ci ? 'true' : undefined,
    OCTONOESIS_DISABLE_MEMORY: '1',
    OCTONOESIS_DISABLE_COMPACT: '1',
    OCTONOESIS_MEMORY_DIR: directory,
    OCTONOESIS_NO_ANIMATION: '1',
  }
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) restoreEnv(key, value)
  const chunks: string[] = []
  const screen = new Screen(24)
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        const value = chunk.toString()
        chunks.push(value)
        screen.feed(value)
        callback()
      },
    }),
    { columns: 80, rows: 24, isTTY: options.tty ?? true },
  )
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  const ctx = { repoRoot: directory, memoryDir: directory }
  let completion: Promise<void> | undefined
  const view = render(
    <App
      ctx={ctx}
      messages={history}
      onQuery={(promise) => {
        completion = promise
      }}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      interactive: !options.ci && options.tty !== false,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  const flush = () => view.waitUntilRenderFlush()
  return {
    chunks,
    screen,
    stdout,
    stdin,
    ctx,
    view,
    flush,
    async resize(columns: number, rows: number) {
      const count = chunks.join('').split(RESIZE_CLEAR).length
      stdout.columns = columns
      stdout.rows = rows
      screen.rows = rows
      stdout.emit('resize')
      await until(() => chunks.join('').split(RESIZE_CLEAR).length > count)
      await flush()
      await until(() => screen.visible.some((line) => line.includes('ctx ')))
    },
    async close() {
      view.unmount()
      await completion
      setProvider(null)
      chalk.level = level
      await flushJournal()
      for (const [key, value] of Object.entries(saved)) restoreEnv(key, value)
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

function pinned(screen: Screen) {
  const lines = screen.visible
  const status = lines.findIndex((line) => line.includes('ctx '))
  expect(status).toBe(22)
  expect(lines[23]?.trim()).toBe('')
  expect(lines[status - 1]).toContain('history')
  expect(lines[status - 2]).toContain('❯')
  expect(lines[status - 3]?.trim()).toBe('')
}

test('resize reprints a single session at the final width and pins short/long sessions', async () => {
  const tty = await terminal()
  try {
    await tty.flush()
    for (const [columns, rows] of [
      [60, 20],
      [100, 30],
      [80, 24],
    ] as const)
      await tty.resize(columns, rows)
    const output = tty.chunks.join('').split(RESIZE_CLEAR).at(-1) ?? ''
    for (const text of [
      'Noe ·',
      'first-resize-message',
      'second-resize-message',
      '✓ Read',
      'resize-reply',
    ]) {
      expect(strip(output).split(text).length - 1).toBe(1)
      expect(tty.screen.lines.join('\n').split(text).length - 1).toBe(1)
    }
    for (const chunk of output.split('\n')) expect(Bun.stringWidth(strip(chunk))).toBeLessThan(80)
    expect(tty.screen.cursorUnderflows).toBe(0)
    expect(tty.screen.lines.join('\n').split('ctx ').length - 1).toBe(1)
    expect(tty.screen.lines.join('\n').split('❯ Type a message').length - 1).toBe(1)
    pinned(tty.screen)
  } finally {
    await tty.close()
  }
  const long = await terminal([
    ...messages,
    {
      role: 'assistant',
      content: [
        { type: 'text', text: Array.from({ length: 60 }, (_, i) => `long-line-${i}`).join('\n') },
      ],
    },
  ])
  try {
    await long.flush()
    pinned(long.screen)
    const liveFrame = [...long.chunks].reverse().find((chunk) => chunk.includes('ctx ')) ?? ''
    expect(strip(liveFrame).split('\n').length).toBe(5)
    expect(long.screen.home > 0).toBe(true)
    expect(long.chunks.join('')).not.toContain('\x1b[3J')
  } finally {
    await long.close()
  }
})

test('committed Noe banner chooses text, above and beside layouts on reprint', async () => {
  const tty = await terminal([{ role: 'user', content: 'layout-message' }], { color: true })
  try {
    await tty.flush()
    for (const [columns, rows, titleRow, mascot] of [
      [45, 18, 0, false],
      [45, 30, 9, true],
      [80, 24, 0, true],
    ] as const) {
      const start = tty.chunks.length
      await tty.resize(columns, rows)
      const banner = tty.chunks.slice(start).find((chunk) => chunk.includes('Noe ·')) ?? ''
      expect(/[▀▄█]/.test(banner)).toBe(mascot)
      expect(
        strip(banner)
          .split('\n')
          .findIndex((line) => line.includes('Noe ·')),
      ).toBe(titleRow)
      expect(tty.screen.cursorUnderflows).toBe(0)
      expect(tty.screen.visible.findIndex((line) => line.includes('ctx '))).toBe(rows - 2)
    }
  } finally {
    await tty.close()
  }
})

test('startup and short transcript stay onscreen with pinned input', async () => {
  for (const history of [[], messages]) {
    const tty = await terminal(history)
    try {
      await tty.flush()
      pinned(tty.screen)
      expect(tty.screen.home).toBe(0)
      expect(tty.chunks.join('')).not.toContain(RESIZE_CLEAR)
      await tty.resize(60, 20)
      await tty.resize(80, 24)
      pinned(tty.screen)
      expect(tty.screen.home).toBe(0)
    } finally {
      await tty.close()
    }
  }
})

test('resize during streaming and permission preserves committed text and resolves y', async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield { type: 'text_delta', text: 'committed-stream-paragraph\n\npending-stream-tail' }
      await gate
      yield { type: 'text_delta', text: '-continued' }
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  const tty = await terminal([
    ...messages,
    { role: 'assistant', content: [{ type: 'text', text: 'long-history\n'.repeat(40) }] },
  ])
  try {
    await tty.flush()
    pinned(tty.screen)
    tty.stdin.write('start-stream')
    await until(() => tty.screen.lines.join('\n').includes('❯ start-stream'))
    tty.stdin.write('\r')
    await until(() => tty.screen.lines.join('\n').includes('pending-stream-tail'))
    await tty.resize(60, 20)
    const output = strip(tty.chunks.join('').split(RESIZE_CLEAR).at(-1) ?? '')
    expect(output.split('committed-stream-paragraph').length - 1).toBe(1)
    expect(tty.screen.lines.join('\n').split('pending-stream-tail').length - 1).toBe(1)
    expect(tty.screen.visible.join('\n')).toContain('ctrl+c to interrupt')
    const decision = requestPermission('Bash', { command: 'echo permission' }, tty.ctx)
    await until(() => tty.screen.visible.join('\n').includes('[Permission Required]'))
    await tty.resize(80, 24)
    expect(tty.screen.visible.join('\n')).toContain('[Permission Required]')
    expect(tty.screen.lines.join('\n').split('committed-stream-paragraph').length - 1).toBe(1)
    tty.stdin.write('y')
    expect(await decision).toBe('allow_once')
    await tty.flush()
    pinned(tty.screen)
    release()
    await until(() => tty.screen.lines.join('\n').includes('pending-stream-tail-continued'))
    await tty.flush()
    pinned(tty.screen)
  } finally {
    release()
    await tty.close()
  }
})

for (const options of [{ ci: true }, { tty: false }])
  test(`non-interactive has no clears or filler: ${JSON.stringify(options)}`, async () => {
    const tty = await terminal([], options)
    try {
      await tty.flush()
      tty.stdout.columns = 60
      tty.stdout.rows = 20
      tty.stdout.emit('resize')
      await tty.flush()
      // No interactive frame is expected: observe beyond the resize debounce
      // to prove a stray reset timer cannot clear redirected/CI output.
      await new Promise((resolve) => setTimeout(resolve, 250))
      tty.view.unmount()
      const output = tty.chunks.join('')
      expect(strip(output)).toContain('Noe ·')
      expect(strip(output)).toContain('ctx ')
      expect(output).not.toContain('\x1b[3J')
      expect(output).not.toContain('\x1b[2J')
      expect(strip(output)).not.toContain('\n\n\n\n')
    } finally {
      await tty.close()
    }
  })
