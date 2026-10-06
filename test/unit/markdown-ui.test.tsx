import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import chalk from 'chalk'
import { render } from 'ink-testing-library'
import React from 'react'
import type { CanonicalMessage } from '../../src/query'
import { App, DisplayEntry, MessageList, StreamingResponse } from '../../src/ui/App'

import { restoreEnv } from '../helpers/env'

let level: typeof chalk.level
beforeEach(() => {
  level = chalk.level
  chalk.level = 1
})
afterEach(() => {
  chalk.level = level
})

test('assistant markdown renders, while user and UI harness text stay verbatim', () => {
  const messages: CanonicalMessage[] = [
    { role: 'assistant', content: [{ type: 'text', text: '**hi**' }] },
    { role: 'user', content: '**x**' },
  ]
  const source = JSON.stringify(messages)
  const view = render(
    <>
      <MessageList messages={messages} />
      <DisplayEntry
        item={{ kind: 'failure', text: 'Query failed: __init__', verbatim: true, header: true }}
      />
      <DisplayEntry
        item={{ kind: 'stats', text: 'stats: __init__', verbatim: true, header: true }}
      />
    </>,
  )
  try {
    expect(view.lastFrame()).toContain('hi')
    expect(view.lastFrame()).not.toContain('**hi**')
    expect(view.lastFrame()).toContain('Query failed: __init__')
    expect(view.lastFrame()).toContain('stats: __init__')
    expect(view.lastFrame()).toContain('**x**')
    expect(JSON.stringify(messages)).toBe(source)
  } finally {
    view.unmount()
  }
})

test('streaming assistant markdown renders without markers', () => {
  const view = render(<StreamingResponse text="**hi**" />)
  try {
    expect(view.lastFrame()).toContain('hi')
    expect(view.lastFrame()).not.toContain('**hi**')
  } finally {
    view.unmount()
  }
})

test('the /stats command preserves bucket names containing markdown underscores', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-ui-stats-'))
  const originalMemoryDir = process.env.OCTONOESIS_MEMORY_DIR
  process.env.OCTONOESIS_MEMORY_DIR = directory
  const record = {
    session_id: 'markdown-ui',
    ts: new Date().toISOString(),
    bucket_key: '__init__',
    model_id: 'test',
    attempt_count: 1,
    first_attempt_success: true,
    user_modifications: 0,
    user_reverts: 0,
    resolved: true,
  }
  let view: ReturnType<typeof render> | undefined
  try {
    await fs.writeFile(path.join(directory, 'calibration.jsonl'), `${JSON.stringify(record)}\n`)
    view = render(<App />)
    view.stdin.write('/stats')
    await new Promise((resolve) => setTimeout(resolve, 50))
    view.stdin.write('\r')
    for (let attempt = 0; attempt < 20 && !view.frames.join('').includes('__init__'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(view.frames.join('')).toContain('__init__')
    expect(view.frames.join('')).toContain('uncertain')
  } finally {
    view?.unmount()
    restoreEnv('OCTONOESIS_MEMORY_DIR', originalMemoryDir)
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('assistant history and streaming frames have no trailing blank line', () => {
  const messages: CanonicalMessage[] = [
    { role: 'assistant', content: [{ type: 'text', text: '**hi**\n\n' }] },
    { role: 'user', content: 'next' },
  ]
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal style sequences
  const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
  const history = render(<MessageList messages={messages} />)
  const streaming = render(<StreamingResponse text="**hi**" />)
  try {
    expect(strip(history.lastFrame() ?? '')).toBe('Agent ›\nhi\nUser › next')
    expect(strip(streaming.lastFrame() ?? '')).toBe('Agent ›\nhi')
  } finally {
    history.unmount()
    streaming.unmount()
  }
})
