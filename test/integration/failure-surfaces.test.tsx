// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess typing is not available in tsconfig.
declare const Bun: any

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { render } from 'ink-testing-library'
import React from 'react'
import { DEFAULT_CONFIG } from '../../src/config/schema'
import { setProvider } from '../../src/providers'
import type { LLMProvider, StreamEvent } from '../../src/providers/types'
import { App } from '../../src/ui/App'

const originalEnv = {
  repoRoot: process.env.OCTONOESIS_REPO_ROOT,
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
  disableCompact: process.env.OCTONOESIS_DISABLE_COMPACT,
}
let root = ''

async function waitForFrame(
  lastFrame: () => string | undefined,
  expected: string,
): Promise<string> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const frame = lastFrame() ?? ''
    if (frame.includes(expected)) return frame
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return lastFrame() ?? ''
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-failure-surface-'))
  process.env.OCTONOESIS_REPO_ROOT = root
  process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'memory')
  process.env.OCTONOESIS_DISABLE_MEMORY = '1'
  process.env.OCTONOESIS_DISABLE_COMPACT = '1'
})

afterEach(async () => {
  setProvider(null)
  await fs.rm(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries({
    OCTONOESIS_REPO_ROOT: originalEnv.repoRoot,
    OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
    OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
    OCTONOESIS_DISABLE_COMPACT: originalEnv.disableCompact,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

describe('query failure surfaces', () => {
  it('returns non-zero and prints a one-shot fatal result to stderr', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return Response.json(
          {
            error: {
              message: 'synthetic one-shot provider failure',
              type: 'invalid_request_error',
            },
          },
          { status: 400 },
        )
      },
    })
    const child = Bun.spawn({
      cmd: [process.execPath, path.resolve('src/cli.tsx'), 'trigger fatal result'],
      cwd: root,
      env: {
        ...process.env,
        LLM_PROVIDER: 'openai',
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        OCTONOESIS_REPO_ROOT: root,
        OCTONOESIS_MEMORY_DIR: path.join(root, 'child-memory'),
        OCTONOESIS_DISABLE_MEMORY: '1',
        OCTONOESIS_DISABLE_COMPACT: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).not.toBe(0)
      expect(stdout).not.toContain('Session summary:')
      expect(stderr).toContain('fatal_error')
      expect(stderr).toContain('synthetic one-shot provider failure')
    } finally {
      server.stop(true)
    }
  })

  it('renders a returned fatal result as a visible TUI message', async () => {
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(): AsyncIterable<StreamEvent> {
        yield await Promise.reject(new Error('synthetic TUI provider failure'))
      },
    }
    setProvider(provider)
    const view = render(
      <App ctx={{ repoRoot: root, messages: [], tasks: new Map(), config: DEFAULT_CONFIG }} />,
    )

    try {
      view.stdin.write('trigger visible failure')
      await new Promise((resolve) => setTimeout(resolve, 20))
      view.stdin.write('\r')
      const frame = await waitForFrame(view.lastFrame, 'synthetic TUI provider failure')

      expect(frame).toContain('fatal_error')
      expect(frame).toContain('synthetic TUI provider failure')
    } finally {
      view.unmount()
    }
  })

  it('clears a pending TUI permission dialog when Ctrl+C aborts the query', async () => {
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(): AsyncIterable<StreamEvent> {
        yield {
          type: 'tool_use',
          id: 'permission-cancel',
          name: 'Bash',
          input: { command: 'printf should-not-run' },
        }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)
    const view = render(
      <App ctx={{ repoRoot: root, messages: [], tasks: new Map(), config: DEFAULT_CONFIG }} />,
    )

    try {
      view.stdin.write('cancel permission')
      await new Promise((resolve) => setTimeout(resolve, 20))
      view.stdin.write('\r')
      const permissionFrame = await waitForFrame(view.lastFrame, 'Permission Required')
      expect(permissionFrame).toContain('Permission Required')

      view.stdin.write('\x03')
      const resumedFrame = await waitForFrame(view.lastFrame, 'Type a message...')
      expect(resumedFrame).not.toContain('Permission Required')
      expect(resumedFrame).toContain('Type a message...')
    } finally {
      view.unmount()
    }
  })

  it('reports the v1.0 CLI version', async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, path.resolve('src/cli.tsx'), '--version'],
      cwd: root,
      env: { ...process.env, OCTONOESIS_REPO_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(code).toBe(0)
    expect(stdout.trim()).toBe('1.1.0')
    expect(stderr).toBe('')
  })

  it('reports a missing captured key for either configured provider', async () => {
    for (const [provider, expected] of [
      ['anthropic', 'ANTHROPIC_API_KEY is not set'],
      ['openai', 'OPENAI_API_KEY is not set'],
    ] as const) {
      const env = {
        ...process.env,
        LLM_PROVIDER: provider,
        OCTONOESIS_REPO_ROOT: root,
      }
      Reflect.deleteProperty(env, 'ANTHROPIC_API_KEY')
      Reflect.deleteProperty(env, 'OPENAI_API_KEY')
      const child = Bun.spawn({
        cmd: [process.execPath, path.resolve('src/cli.tsx'), 'missing key probe'],
        cwd: root,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

      expect(code).not.toBe(0)
      expect(stderr).toContain(expected)
    }
  })
})
