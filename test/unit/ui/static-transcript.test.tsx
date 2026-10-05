// biome-ignore lint/suspicious/noExplicitAny: Bun.main is writable in the test runtime.
declare const Bun: any

import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { render } from 'ink'
import React from 'react'
import { setProvider } from '../../../src/providers'
import type { CanonicalMessage, ToolContext } from '../../../src/query'
import { getTodos, setTodos } from '../../../src/state/todos'
import { enqueueTaskNotification } from '../../../src/tasks/framework'
import { App } from '../../../src/ui/App'
import { restoreEnv } from '../../helpers/env'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('long replies and ten tools never clear the fake TTY', async () => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'static-transcript-')),
  )
  const env = {
    OCTONOESIS_MEMORY_DIR: directory,
    OCTONOESIS_DISABLE_MEMORY: '1',
    OCTONOESIS_DISABLE_COMPACT: '1',
  }
  const originals = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  let output = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    }),
    { isTTY: true, rows: 24, columns: 80 },
  )
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  let turn = 0
  let finished = false
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      if (turn++ === 0) {
        for (let line = 0; line < 200; line++) {
          yield { type: 'text_delta', text: `oracle-line-${String(line).padStart(3, '0')}\n\n` }
          await delay(4)
        }
        for (let tool = 0; tool < 10; tool++)
          yield {
            type: 'tool_use',
            id: `tool-${tool}`,
            name: 'Read',
            input: { path: 'fixture.txt' },
          }
      } else {
        yield { type: 'text_delta', text: 'oracle-finished' }
        finished = true
      }
      yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 10 } }
    },
  })
  await fs.writeFile(path.join(directory, 'fixture.txt'), 'fixture')
  const view = render(<App ctx={{ repoRoot: directory, memoryDir: directory }} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
    interactive: true,
  })
  try {
    await delay(30)
    stdin.write('run oracle')
    await delay(30)
    stdin.write('\r')
    for (let i = 0; i < 300 && !finished; i++) await delay(20)
    expect(finished).toBe(true)
    await delay(100)
    view.unmount()
    expect(output).not.toContain('\x1b[2J')
    expect(output).not.toContain('\x1b[3J')
    expect(output.split('oracle-line-000').length - 1).toBe(1)
    expect(output.split('oracle-line-199').length - 1).toBe(1)
    expect(output.split('(done)').length - 1).toBe(10)
    expect(turn).toBe(2)
  } finally {
    view.unmount()
    setProvider(null)
    for (const [key, value] of Object.entries(originals)) restoreEnv(key, value)
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('compaction shrinks model history while resumed history, task notices and the next reply print once', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'static-compact-')))
  const env = {
    OCTONOESIS_MEMORY_DIR: directory,
    OCTONOESIS_DISABLE_MEMORY: '1',
    OCTONOESIS_DISABLE_COMPACT: undefined,
    OCTONOESIS_COMPACT_THRESHOLD: '1000',
    OCTONOESIS_FORK_MOCK: JSON.stringify({ text: 'short compact summary' }),
    OCTONOESIS_FORK_DEPTH: undefined,
  }
  const originals = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) restoreEnv(key, value)
  const originalMain = Bun.main
  Bun.main = path.resolve('src/cli.tsx')
  let output = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    }),
    { isTTY: true, rows: 24, columns: 80 },
  )
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  const history: CanonicalMessage[] = []
  for (let index = 0; index < 12; index++) {
    history.push({ role: 'user', content: `resumed-prompt-${index}: ${'old '.repeat(100)}` })
    history.push({
      role: 'assistant',
      content: [{ type: 'text', text: `resumed-reply-${index}: ${'reply '.repeat(100)}` }],
    })
  }
  history.push(
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'resumed-tool-id', name: 'Read', input: { path: 'resumed-file' } },
      ],
    },
    { role: 'tool', tool_use_id: 'resumed-tool-id', content: 'ok' },
  )
  const ctx: ToolContext = { repoRoot: directory, memoryDir: directory, messages: history }
  enqueueTaskNotification(ctx, {
    id: 'notice-before',
    type: 'shell',
    status: 'completed',
    startTime: 0,
    command: 'before command',
    exitCode: 0,
  })
  let calls = 0
  let shrank = false
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      shrank ||= ctx.messages !== history && (ctx.messages?.length ?? 0) < history.length
      if (calls++ === 0) {
        enqueueTaskNotification(ctx, {
          id: 'notice-during',
          type: 'shell',
          status: 'completed',
          startTime: 0,
          command: 'during command',
          exitCode: 0,
        })
        yield { type: 'tool_use', id: 'read-new', name: 'Read', input: { path: 'fixture.txt' } }
      } else yield { type: 'text_delta', text: `after-compact-reply-${calls}\n\n` }
      yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 10 } }
    },
  })
  await fs.writeFile(path.join(directory, 'fixture.txt'), 'fixture')
  const view = render(
    <App
      ctx={ctx}
      resumeInfo={{ sessionId: 'resume-session', messageCount: history.length, updatedAt: 'today' }}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      incrementalRendering: false,
      interactive: true,
    },
  )
  try {
    await delay(30)
    stdin.write('continue')
    await delay(30)
    stdin.write('\r')
    for (let i = 0; i < 200 && !output.includes('after-compact-reply-2'); i++) await delay(20)
    expect(shrank).toBe(true)
    expect(output).toContain('Context compacted:')
    expect(output).toContain('after-compact-reply-2')
    await delay(100)
    stdin.write('next turn')
    await delay(30)
    stdin.write('\r')
    for (let i = 0; i < 100 && !output.includes('after-compact-reply-3'); i++) await delay(20)
    await delay(100)
    view.unmount()
    for (const marker of [
      'Resumed resume-s',
      ...Array.from({ length: 12 }, (_, index) => [
        `resumed-prompt-${index}:`,
        `resumed-reply-${index}:`,
      ]).flat(),
      'resumed-file',
      'Task › notice-before',
      'Task › notice-during',
      'after-compact-reply-2',
      'after-compact-reply-3',
    ]) {
      expect(output.split(marker).length - 1).toBe(1)
    }
    expect(output).not.toContain('\x1b[2J')
    expect(output).not.toContain('\x1b[3J')
  } finally {
    view.unmount()
    setProvider(null)
    Bun.main = originalMain
    for (const [key, value] of Object.entries(originals)) restoreEnv(key, value)
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('an unclosed 200-line fence and a tall todo panel stay bounded, then commit the full fence', async () => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'static-fence-')))
  const env = {
    OCTONOESIS_MEMORY_DIR: directory,
    OCTONOESIS_DISABLE_MEMORY: '1',
    OCTONOESIS_DISABLE_COMPACT: '1',
  }
  const originals = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  const originalTodos = getTodos()
  setTodos(
    Array.from({ length: 100 }, (_, index) => ({
      id: String(index),
      content: `todo-${index} ${'long '.repeat(30)}`,
      status: 'open',
    })),
  )
  let output = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    }),
    { isTTY: true, rows: 24, columns: 80 },
  )
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let pending = false
  let finished = false
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield { type: 'text_delta', text: '```ts\n' }
      for (let index = 0; index < 200; index++) {
        yield { type: 'text_delta', text: `fence-line-${String(index).padStart(3, '0')}\n` }
        await delay(1)
      }
      pending = true
      await gate
      yield { type: 'text_delta', text: '```\n\n' }
      yield { type: 'message_end', usage: { input_tokens: 10, output_tokens: 10 } }
      finished = true
    },
  })
  const view = render(<App ctx={{ repoRoot: directory, memoryDir: directory }} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: false,
    interactive: true,
  })
  try {
    await delay(30)
    stdin.write('fence please')
    await delay(30)
    stdin.write('\r')
    for (let i = 0; i < 150 && !pending; i++) await delay(20)
    expect(pending).toBe(true)
    await delay(60)
    // The latest repaint must retain the actual last line, including with the header and marker.
    const frame = output.slice(output.lastIndexOf('\x1b[G'))
    expect(frame).toContain('… 188 lines above')
    expect(frame).toContain('fence-line-199')
    expect(frame).not.toContain('fence-line-000')
    expect(frame).toContain('+91 more')
    const beforeCommit = output.length
    release()
    for (let i = 0; i < 100 && !finished; i++) await delay(20)
    expect(finished).toBe(true)
    await delay(100)
    view.unmount()
    const committed = output.slice(beforeCommit)
    expect(committed.split('fence-line-000').length - 1).toBe(1)
    expect(committed.split('fence-line-199').length - 1).toBe(1)
    expect(output).not.toContain('\x1b[2J')
    expect(output).not.toContain('\x1b[3J')
  } finally {
    release()
    view.unmount()
    setProvider(null)
    setTodos(originalTodos)
    for (const [key, value] of Object.entries(originals)) restoreEnv(key, value)
    await fs.rm(directory, { recursive: true, force: true })
  }
})
