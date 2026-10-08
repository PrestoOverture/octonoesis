declare const Bun: { stringWidth(text: string): number }
import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { stripVTControlCharacters as strip } from 'node:util'
import { Box, render } from 'ink'
import React from 'react'
import { flushJournal } from '../../../src/memory/journal'
import { requestPermission } from '../../../src/permissions/confirm'
import { setProvider } from '../../../src/providers'
import { readTool } from '../../../src/tools/Read'
import { registerTool } from '../../../src/tools/registry'
import { App } from '../../../src/ui/App'
import { ToolCard } from '../../../src/ui/ToolCard'
import { renderMarkdown } from '../../../src/ui/markdown'
import { wrapAssistant } from '../../../src/ui/wrapAssistant'
import { restoreEnv } from '../../helpers/env'

function tty(columns: number, rows: number) {
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
  return {
    chunks,
    stdin,
    options: {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      interactive: true,
      incrementalRendering: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
    async waitFor(predicate: (frame: string) => boolean) {
      for (let i = 0; i < 500; i++) {
        const frame = [...chunks].reverse().map(strip).find(predicate)
        if (frame !== undefined) return frame
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`Missing measured frame: ${strip(chunks.join('')).slice(-1800)}`)
    },
    check() {
      for (const chunk of chunks)
        for (const line of strip(chunk).split('\n'))
          expect(Bun.stringWidth(line)).toBeLessThan(columns)
      expect(chunks.join('')).not.toContain('\x1b[2J')
      expect(chunks.join('')).not.toContain('\x1b[3J')
    },
  }
}

test('80-column resumed tools shorten realpath aliases and preserve long-argument summaries', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ui2-delta-'))
  const repo = path.join(temporary, 'repository-'.repeat(12))
  const alias = path.join(temporary, 'alias')
  await fs.mkdir(repo)
  await fs.symlink(repo, alias)
  const root = await fs.realpath(repo)
  const file = `${root}/src/x.ts`
  expect(file.length >= 120).toBe(true)
  const env = {
    OCTONOESIS_MEMORY_DIR: temporary,
    OCTONOESIS_DISABLE_MEMORY: '1',
    OCTONOESIS_DISABLE_COMPACT: '1',
  }
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  registerTool({
    name: 'Read',
    description: 'Scripted display fixture',
    inputSchema: readTool.inputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async () => ({ ok: true, value: '1\tone\n2\ttwo\n3\tthree' }),
  })
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let turn = 0
  setProvider({
    name: 'anthropic',
    async *createMessageStream() {
      if (turn++ === 0) {
        yield { type: 'tool_use', id: 'live', name: 'Read', input: { path: file } }
        await pending
      } else yield { type: 'text_delta', text: 'live-finished' }
      yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
    },
  })
  let completion: Promise<void> | undefined
  const terminal = tty(80, 24)
  const view = render(
    <App
      ctx={{ repoRoot: alias, memoryDir: temporary }}
      onQuery={(promise) => {
        completion = promise
      }}
      messages={[
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'b',
              name: 'Bash',
              input: { command: `cd ${root} && bun test` },
            },
            { type: 'tool_use', id: 'r', name: 'Read', input: { path: file } },
            {
              type: 'tool_use',
              id: 'long',
              name: 'Read',
              input: { path: `${root}/${'long-file-'.repeat(25)}.ts` },
            },
          ],
        },
        { role: 'tool', tool_use_id: 'b', content: '{"code":1,"stdout":"","stderr":""}' },
        { role: 'tool', tool_use_id: 'r', content: '1\tone\n2\ttwo' },
        { role: 'tool', tool_use_id: 'long', content: '1\tone' },
      ]}
      streamingToolUses={[{ name: 'Bash', input: { command: `cd ${alias}; bun test` } }]}
    />,
    terminal.options,
  )
  try {
    await terminal.waitFor((frame) => frame.includes('✓ Read src/x.ts · 2 lines'))
    const output = strip(terminal.chunks.join(''))
    expect(output).toContain('✗ Bash bun test · exit 1')
    expect(output).toContain('… Bash bun test')
    const long = output.split('\n').find((line) => line.includes('✓ Read long-file')) ?? ''
    expect(long.trimEnd().endsWith(' · 1 line')).toBe(true)
    expect(long).toContain('…')
    terminal.check()
    terminal.chunks.length = 0
    terminal.stdin.write('read live')
    await terminal.waitFor((frame) => frame.includes('❯ read live'))
    terminal.stdin.write('\r')
    await terminal.waitFor((frame) => frame.includes('… Read src/x.ts'))
    release()
    await terminal.waitFor((frame) => frame.includes('✓ Read src/x.ts · 3 lines'))
    await completion
    terminal.check()
    terminal.chunks.length = 0
    view.rerender(
      <Box width={12}>
        <ToolCard tool="AnOverlongName" args="arg" status="done" summary="long summary" />
      </Box>,
    )
    const fallback = await terminal.waitFor((frame) => frame.includes('✓ AnOver'))
    expect(fallback.trim().split('\n').length).toBe(1)
    expect(Bun.stringWidth(fallback.trim())).toBeLessThan(13)
  } finally {
    release()
    await completion
    view.unmount()
    setProvider(null)
    registerTool(readTool)
    await flushJournal()
    for (const [key, value] of Object.entries(saved)) restoreEnv(key, value)
    await fs.rm(temporary, { recursive: true, force: true })
  }
}, 15000)

const paragraph =
  'These words describe the behavior of the assistant and explain failures when a long response needs to wrap in a narrow terminal. '.repeat(
    5,
  )
for (const [columns, rows] of [
  [80, 24],
  [60, 20],
] as const)
  test(`assistant wrapping and input/confirmation spacing at ${columns}x${rows}`, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ui2-delta-wrap-'))
    const terminal = tty(columns, rows)
    const ctx = { repoRoot: temporary, memoryDir: temporary }
    const view = render(
      <App
        ctx={ctx}
        messages={[
          { role: 'user', content: 'explain' },
          {
            role: 'assistant',
            content: [{ type: 'text', text: `${paragraph}\n\n\`\`\`ts\n  indentedCode()\n\`\`\`` }],
          },
        ]}
        streamingText={paragraph}
      />,
      terminal.options,
    )
    let decision: Promise<string> | undefined
    try {
      await terminal.waitFor((frame) => frame.includes('indentedCode'))
      const committed = strip(terminal.chunks.join(''))
      expect(committed).toContain('    indentedCode()')
      for (const line of committed
        .split('\n')
        .filter((line) => line.trim() && !line.includes('indentedCode'))) {
        if (
          line.includes('These words') ||
          line.includes('failures') ||
          line.includes('narrow terminal')
        )
          expect(line.startsWith(' ')).toBe(false)
      }
      const dynamic = await terminal.waitFor(
        (frame) => frame.includes('❯ Type a message') && frame.includes('These words'),
      )
      const lines = dynamic.trimEnd().split('\n')
      expect(lines.length).toBeLessThan(rows)
      const wrappedLines = wrapAssistant(
        renderMarkdown(paragraph).replace(/\n+$/, ''),
        columns - 1,
      ).split('\n')
      const hidden = Math.max(0, wrappedLines.length - (rows - 9))
      if (hidden) expect(dynamic).toContain(`… ${hidden} lines above`)
      const prompt = lines.findIndex((line) => line.includes('❯ Type a message'))
      expect(lines[prompt - 1]?.trim()).toBe('')
      for (const line of lines.slice(0, prompt).filter((line) => line.trim()))
        expect(line.startsWith(' ')).toBe(false)
      terminal.check()
      terminal.chunks.length = 0
      decision = requestPermission('Bash', { command: 'echo spacing' }, ctx)
      const confirm = await terminal.waitFor((frame) => frame.includes('[Permission Required]'))
      const confirmationLines = confirm.trimEnd().split('\n')
      const border = confirmationLines.findIndex((line) => line.startsWith('╭'))
      expect(border > 0).toBe(true)
      expect(confirmationLines[border - 1]?.trim()).toBe('')
      expect(confirmationLines.length).toBeLessThan(rows)
      terminal.check()
      terminal.stdin.write('n')
      expect(await decision).toBe('deny')
    } finally {
      view.unmount()
      await fs.rm(temporary, { recursive: true, force: true })
    }
  })

test('ANSI paragraph wrapping preserves explicit blank lines and code indentation', () => {
  const text = `\x1b[31m${paragraph}\x1b[39m\n\n    code()`
  const wrapped = wrapAssistant(text, 59)
  expect(wrapped).toContain('\x1b[31m')
  expect(strip(wrapped)).toContain('\n\n    code()')
  const lines = strip(wrapped).split('\n')
  for (const line of lines) {
    expect(Bun.stringWidth(line)).toBeLessThan(60)
    if (!line.includes('code()')) expect(line.startsWith(' ')).toBe(false)
  }
  expect(strip(wrapAssistant(renderMarkdown('```ts\n  nested()\n```'), 59))).toContain(
    '    nested()',
  )
})
