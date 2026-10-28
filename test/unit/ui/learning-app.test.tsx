import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters as strip } from 'node:util'
import { render } from 'ink'
import React from 'react'
import { flushJournal } from '../../../src/memory/journal'
import { saveRule } from '../../../src/memory/rules/store'
import { setProvider } from '../../../src/providers'
import { App } from '../../../src/ui/App'
import { restoreEnv } from '../../helpers/env'
import { seededRule } from '../../helpers/learningScript'

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Missing App frame')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('App consumes learning events and OB-8 reprints them at the new width', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ui3-app-'))
  const env = {
    CI: undefined,
    OCTONOESIS_MEMORY_DIR: path.join(root, 'memory'),
    OCTONOESIS_REPO_ROOT: root,
    OCTONOESIS_DISABLE_MEMORY: undefined,
    OCTONOESIS_DISABLE_AUTO_DISTILL: '1',
    OCTONOESIS_NO_ANIMATION: '1',
    OCTONOESIS_DISABLE_COMPACT: '1',
  }
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) restoreEnv(key, value)
  const chunks: string[] = []
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString())
        callback()
      },
    }),
    { columns: 80, rows: 24, isTTY: true },
  )
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  await saveRule(seededRule())
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      yield { type: 'text_delta', text: 'Done learning turn.' }
      yield {
        type: 'message_end',
        stopReason: 'other',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
  })
  let completion: Promise<void> | undefined
  const view = render(
    <App
      ctx={{ repoRoot: root, memoryDir: path.join(root, 'memory') }}
      onQuery={(value) => {
        completion = value
      }}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await view.waitUntilRenderFlush()
    expect(strip(chunks.join(''))).not.toContain('✻ recalled')
    stdin.write('hello-learning')
    await until(() => strip(chunks.join('')).includes('hello-learning'))
    stdin.write('\r')
    await until(() => completion !== undefined)
    await completion
    await until(() => strip(chunks.join('')).includes('✻ recalled 1 rule for this repo'))
    const clear = '\x1b[2J\x1b[3J\x1b[H'
    stdout.columns = 60
    stdout.rows = 20
    stdout.emit('resize')
    await until(() => chunks.join('').includes(clear))
    await until(() =>
      strip(chunks.join('').split(clear).at(-1) ?? '').includes('✻ recalled 1 rule for this repo'),
    )
    expect(strip(chunks.join('').split(clear).at(-1) ?? '')).toContain('Done learning turn.')
  } finally {
    view.unmount()
    await completion
    view.cleanup()
    setProvider(null)
    await flushJournal()
    for (const [key, value] of Object.entries(saved)) restoreEnv(key, value)
    await fs.rm(root, { recursive: true, force: true })
  }
})
