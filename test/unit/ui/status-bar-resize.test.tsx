declare const Bun: { stringWidth(text: string): number }
import { expect, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters as strip } from 'node:util'
import { Box, render } from 'ink'
import React from 'react'
import { StatusBar } from '../../../src/ui/StatusBar'

for (const [columns, rows] of [
  [45, 40],
  [80, 24],
  [60, 20],
]) {
  test(`status bar is one parent-width line at ${columns}x${rows}`, async () => {
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
      <Box width="100%" paddingRight={1}>
        <StatusBar
          modelName="test-model"
          inputTokens={1200}
          outputTokens={300}
          costUsd={0.0123}
          priced
          contextUtilization={0.12}
        />
      </Box>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      for (let i = 0; i < 500 && !chunks.some((chunk) => strip(chunk).includes('test-model')); i++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      const frame = strip(
        chunks.find((chunk) => strip(chunk).includes('test-model')) ?? '',
      ).trimEnd()
      expect(frame.split('\n').length).toBe(1)
      expect(Bun.stringWidth(frame)).toBeLessThan(columns ?? 0)
      if ((columns ?? 0) >= 60)
        expect(frame).toBe('test-model · $0.0123 · ctx 12% · 1.2k in / 300 out')
      else expect(frame).toContain('test-model · $0.0123 · ctx 12%')
    } finally {
      view.unmount()
    }
  })
}
