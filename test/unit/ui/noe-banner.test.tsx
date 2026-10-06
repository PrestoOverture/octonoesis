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
import { App } from '../../../src/ui/App'
import { bannerLayout, version } from '../../../src/ui/banner'
import { createFrames } from '../../../src/ui/mascot'
import { restoreEnv } from '../../helpers/env'

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
  const tty = await terminal()
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
    await delay(2000)
    const eyeLines = [
      ...new Set(
        createFrames().map((frame) => normalized(frame).split('\n').slice(5, 8).join('\n')),
      ),
    ]
    expect(eyeLines.length).toBe(3)
    for (const line of eyeLines) expect(normalized(tty.chunks.join(''))).toContain(line)
    tty.stdin.write('hello')
    await delay(40)
    const start = tty.chunks.length
    tty.stdin.write('\r')
    await delay(1350)
    const afterSubmit = tty.chunks.slice(start).join('')
    expect(afterSubmit.split(`Noe · Octonoesis v${version}`).length - 1).toBe(1)
    expect(normalized(afterSubmit)).toContain(
      normalized(createFrames()[1] ?? '')
        .split('\n')
        .slice(5, 8)
        .join('\n'),
    )
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
  'short terminal': { rows: 20 },
  'narrow terminal': { columns: 50 },
  'resumed session': { resume: true },
  'non-TTY': { tty: false },
})) {
  test(`${name}: static banner with no timer writes`, async () => {
    const tty = await terminal(options)
    try {
      await delay(150)
      const before = tty.chunks.length
      await delay(1000)
      expect(tty.chunks.length).toBe(before)
      const output = tty.chunks.join('')
      expect(output).toContain(`Noe · Octonoesis v${version}`)
      expect(output.split(`Noe · Octonoesis v${version}`).length - 1).toBe(1)
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
  expect(bannerLayout(75, 40, 7, true)).toBe('above')
  expect(bannerLayout(60, 40, 7, true)).toBe('above')
  expect(bannerLayout(59, 40, 7, true)).toBe('text')
  expect(bannerLayout(100, 20, 7, true)).toBe('text')
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
