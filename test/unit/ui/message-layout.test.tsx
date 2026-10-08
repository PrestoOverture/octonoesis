declare const Bun: { stringWidth(text: string): number }
import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters as strip } from 'node:util'
import { Box, render } from 'ink'
import React from 'react'
import { App } from '../../../src/ui/App'
import { ConfirmDialog } from '../../../src/ui/ConfirmDialog'
import { ToolCard } from '../../../src/ui/ToolCard'
import { wrapProseLines } from '../../../src/ui/previewLines'

for (const [columns, rows] of [
  [80, 24],
  [60, 20],
] as const)
  test(`message layout at ${columns}x${rows}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ui2-layout-'))
    const chunks: string[] = []
    const stdout = Object.assign(
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString())
          callback()
        },
      }),
      { isTTY: true, columns, rows },
    )
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {},
      ref() {},
      unref() {},
    })
    const view = render(
      <App
        ctx={{ repoRoot: directory, memoryDir: directory }}
        messages={[
          { role: 'user', content: 'inspect this file' },
          { role: 'assistant', content: [{ type: 'text', text: 'I will inspect it.' }] },
        ]}
        streamingText="Working on it"
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
        interactive: true,
        incrementalRendering: false,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    const waitFor = async (text: string) => {
      for (let i = 0; i < 500 && !chunks.some((chunk) => strip(chunk).includes(text)); i++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(chunks.some((chunk) => strip(chunk).includes(text))).toBe(true)
    }
    const checkWidths = () => {
      for (const chunk of chunks)
        for (const line of strip(chunk).split('\n'))
          expect(Bun.stringWidth(line)).toBeLessThan(columns)
      expect(chunks.join('')).not.toContain('\x1b[2J')
      expect(chunks.join('')).not.toContain('\x1b[3J')
    }
    try {
      await waitFor('Type a message')
      const output = strip(chunks.join(''))
      expect(output).toContain('❯ inspect this file')
      expect(output).not.toContain('User ›')
      expect(output).not.toContain('Agent ›')
      const frame = strip(
        [...chunks].reverse().find((chunk) => strip(chunk).includes('Type a message')) ?? '',
      )
      expect(frame.trimEnd().split('\n').length).toBeLessThan(rows)
      expect(frame.split('\n').filter((line) => line.includes('ctx ')).length).toBe(1)
      checkWidths()
      chunks.length = 0
      view.rerender(
        <Box width="100%" paddingRight={1}>
          <ToolCard
            tool="Bash"
            args={`${'long-command '.repeat(30)}\nSECOND-LINE`}
            status="done"
            summary="exit 0"
          />
        </Box>,
      )
      await waitFor('✓ Bash')
      const toolFrame = strip(chunks.find((chunk) => strip(chunk).includes('✓ Bash')) ?? '').trim()
      expect(toolFrame.split('\n').length).toBe(1)
      expect(toolFrame).not.toContain('SECOND-LINE')
      checkWidths()
      chunks.length = 0
      view.rerender(
        <Box width="100%" paddingRight={1}>
          <ConfirmDialog
            toolName="Bash"
            input={{ command: 'echo hello' }}
            maxHeight={rows - 1}
            onResolve={() => {}}
          />
        </Box>,
      )
      await waitFor('Press [y]')
      const confirmation = strip(
        [...chunks].reverse().find((chunk) => strip(chunk).includes('Press [y]')) ?? '',
      )
      const prose = confirmation.split('\n').map((line) => line.replace(/^[│ ]+|[│ ]+$/g, ''))
      const start = prose.findIndex((line) => line.startsWith('Press [y]'))
      expect(prose.slice(start, start + 2).join(' ')).toContain(
        'Press [y] Yes once / [n] No / [a] Always allow for this input',
      )
      checkWidths()
    } finally {
      view.unmount()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

test('prose wraps words but hard breaks only overlong words', () => {
  expect(wrapProseLines('one two three', 7)).toEqual(['one two', 'three'])
  expect(wrapProseLines('one abcdefghij end', 5)).toEqual(['one', 'abcde', 'fghij', 'end'])
})
