import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { render } from 'ink'
import React from 'react'
import { requestPermission } from '../../../src/permissions/confirm'
import { App } from '../../../src/ui/App'

const delay = () => new Promise((resolve) => setTimeout(resolve, 60))

async function confirmation(
  rows: number,
  tool: string,
  input: unknown,
  check: (frame: string) => void,
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'confirmation-budget-'))
  let output = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    }),
    { isTTY: true, rows, columns: 80 },
  )
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  })
  const controller = new AbortController()
  const ctx = { repoRoot: directory, memoryDir: directory, abortSignal: controller.signal }
  const view = render(
    <App
      ctx={ctx}
      streamingText="hidden pending reply"
      streamingToolUses={[{ name: 'hidden running tool' }]}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
      incrementalRendering: false,
      interactive: true,
    },
  )
  let decision: Promise<string> | undefined
  try {
    await delay()
    decision = requestPermission(tool, input, ctx)
    await delay()
    const frame = output
      .slice(output.lastIndexOf('\x1b[G') + 3)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal controls for visible row checks
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .trimEnd()
    check(frame)
    expect(frame).not.toContain('hidden pending reply')
    expect(frame).not.toContain('hidden running tool')
    expect(frame.split('\n').length <= rows - 1).toBe(true)
    expect(frame).toContain('[y]')
    expect(frame).toContain('[n]')
    stdin.write('n')
    expect(await decision).toBe('deny')
    await delay()
    view.unmount()
    expect(output).not.toContain('\x1b[2J')
    expect(output).not.toContain('\x1b[3J')
  } finally {
    controller.abort()
    await decision
    view.unmount()
    await fs.rm(directory, { recursive: true, force: true })
  }
}

for (const rows of [40, 24]) {
  test(`Edit approval exposes its diff at ${rows} rows with an exact hidden count`, async () => {
    await confirmation(
      rows,
      'Edit',
      {
        path: 'example.ts',
        old_string: `${Array.from({ length: 20 }, (_, index) => `old-value-${index}`).join('\n')}\n`,
        new_string: `${Array.from({ length: 20 }, (_, index) => `new-value-${index}`).join('\n')}\n`,
      },
      (frame) => {
        const visible = frame.match(/[+-](?:old|new)-value-\d+/g) ?? []
        expect(visible.length >= (rows === 40 ? 25 : 8)).toBe(true)
        const notices = [...frame.matchAll(/… (\d+) more diff lines not shown/g)]
        expect(notices.length).toBe(1)
        expect(Number(notices[0]?.[1])).toBe(40 - visible.length)
      },
    )
  })
}

test('a 300-character Bash command is fully visible at 24 rows', async () => {
  const command = '0123456789'.repeat(30)
  await confirmation(24, 'Bash', { command }, (frame) => {
    const digits = frame.match(/[0-9]+/g)?.join('') ?? ''
    expect(digits).toContain(command)
    expect(frame).not.toContain('more lines not shown')
  })
})

test('oversized parameters end with one accurate truncation notice', async () => {
  await confirmation(24, 'Bash', 'payload\n'.repeat(50).trimEnd(), (frame) => {
    const shown = frame.match(/payload/g)?.length ?? 0
    const notices = [...frame.matchAll(/… (\d+) more lines not shown/g)]
    expect(notices.length).toBe(1)
    expect(Number(notices[0]?.[1])).toBe(50 - shown)
  })
})
