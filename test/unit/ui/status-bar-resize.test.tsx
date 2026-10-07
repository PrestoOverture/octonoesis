declare const Bun: { stringWidth(text: string): number }
import { expect, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { render } from 'ink'
import React from 'react'
import { StatusBar } from '../../../src/ui/StatusBar'

for (const columns of [45, 60]) {
  test(`status bar at ${columns} columns keeps model and cost/context separate`, async () => {
    let raw = ''
    const stdout = Object.assign(
      new Writable({
        write(chunk, _encoding, callback) {
          raw += chunk.toString()
          callback()
        },
      }),
      { isTTY: true, columns, rows: 40 },
    )
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode() {},
      ref() {},
      unref() {},
    })
    const view = render(
      <StatusBar
        modelName="claude-haiku-4-5-20251001"
        inputTokens={1200}
        outputTokens={300}
        costUsd={0.0123}
        priced
        contextUtilization={0.42}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stdout as unknown as NodeJS.WriteStream,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    view.unmount()
    const output = stripVTControlCharacters(raw)
    const lines = output.split('\n')
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThan(columns + 1)
    expect(output).toContain('Model: claude-haiku-4-5-20251001')
    expect(output).toContain('cost: $0.0123 | ctx: 42%')
    expect(output).toContain('in: 1.2k | out: 300 | total: 1.5k')
    expect(lines.findIndex((line) => line.includes('Model:'))).toBeLessThan(
      lines.findIndex((line) => line.includes('cost:')),
    )
  })
}
