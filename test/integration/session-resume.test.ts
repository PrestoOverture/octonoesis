// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the test runtime.
declare const Bun: any

import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG } from '../../src/config/schema.ts'
import { setProvider } from '../../src/providers/index.ts'
import type { LLMProvider, StreamEvent } from '../../src/providers/types.ts'
import { query } from '../../src/query/engine.ts'
import { loadSession, saveSession } from '../../src/state/sessionStore.ts'

const roots: string[] = []
const cliPath = path.join(process.cwd(), 'src/cli.tsx')
const originalEnv = {
  memoryDir: process.env.OCTONOESIS_MEMORY_DIR,
  disableMemory: process.env.OCTONOESIS_DISABLE_MEMORY,
  disableCompact: process.env.OCTONOESIS_DISABLE_COMPACT,
}

afterEach(async () => {
  setProvider(null)
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  for (const [key, value] of Object.entries({
    OCTONOESIS_MEMORY_DIR: originalEnv.memoryDir,
    OCTONOESIS_DISABLE_MEMORY: originalEnv.disableMemory,
    OCTONOESIS_DISABLE_COMPACT: originalEnv.disableCompact,
  })) {
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

function textResponse(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

interface ProviderRequest {
  messages?: Array<{ role: string; content?: string | null }>
}

async function withServer<T>(
  run: (baseUrl: string, requests: ProviderRequest[]) => Promise<T>,
): Promise<T> {
  const requests: ProviderRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request: Request) {
      requests.push((await request.json()) as ProviderRequest)
      return textResponse('mock completion')
    },
  })
  try {
    return await run(`http://127.0.0.1:${server.port}/v1`, requests)
  } finally {
    server.stop(true)
  }
}

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'octonoesis-session-resume-'))
  roots.push(root)
  return root
}

async function runCli(root: string, baseUrl: string, args: string[]) {
  const memoryDir = path.join(root, 'memory')
  const child = Bun.spawn({
    cmd: [process.execPath, cliPath, ...args],
    cwd: root,
    env: {
      ...process.env,
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'local-mock-key',
      OPENAI_BASE_URL: baseUrl,
      OCTONOESIS_REPO_ROOT: root,
      OCTONOESIS_MEMORY_DIR: memoryDir,
      OCTONOESIS_DISABLE_MEMORY: '1',
      OCTONOESIS_DISABLE_COMPACT: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr, memoryDir }
}

async function runSessionsCli(root: string, memoryDir: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OCTONOESIS_REPO_ROOT: root,
    OCTONOESIS_MEMORY_DIR: memoryDir,
  }
  Reflect.deleteProperty(env, 'ANTHROPIC_API_KEY')
  Reflect.deleteProperty(env, 'OPENAI_API_KEY')
  const child = Bun.spawn({
    cmd: [process.execPath, cliPath, 'sessions'],
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe('persistent session CLI', () => {
  it('writes exactly one session snapshot for one-shot --save-session', async () => {
    const root = await tempRoot()
    await withServer(async (baseUrl) => {
      const result = await runCli(root, baseUrl, ['--save-session', 'plant session canary'])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      const files = await fs.readdir(path.join(result.memoryDir, 'sessions'))
      expect(files.length).toBe(1)
      const sessionId = files[0]?.replace(/\.json$/, '') ?? ''
      const saved = await loadSession(sessionId, { memoryDir: result.memoryDir })
      expect(saved.messages[0]).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'plant session canary' }],
      })
      expect(saved.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'mock completion' }],
      })
    })
  })

  it('resumes prior messages into a new one-shot session id', async () => {
    const root = await tempRoot()
    await withServer(async (baseUrl, requests) => {
      const first = await runCli(root, baseUrl, [
        '--save-session',
        'The process-death canary is cobalt.',
      ])
      expect(first.exitCode).toBe(0)
      const firstFiles = await fs.readdir(path.join(first.memoryDir, 'sessions'))
      const firstId = firstFiles[0]?.replace(/\.json$/, '') ?? ''

      const second = await runCli(root, baseUrl, [
        '--resume',
        firstId,
        'What was the process-death canary?',
      ])

      expect(second.exitCode).toBe(0)
      expect(second.stderr).toBe('')
      const secondRequestMessages = requests[1]?.messages ?? []
      expect(secondRequestMessages.some((message) => message.content?.includes('cobalt'))).toBe(
        true,
      )
      expect(
        secondRequestMessages.some((message) =>
          message.content?.includes('What was the process-death canary?'),
        ),
      ).toBe(true)
      const allFiles = await fs.readdir(path.join(second.memoryDir, 'sessions'))
      expect(allFiles.length).toBe(2)
      expect(allFiles).toContain(`${firstId}.json`)
    })
  })

  it('--continue picks the most recent saved session for the current repo', async () => {
    const root = await tempRoot()
    const memoryDir = path.join(root, 'memory')
    await saveSession(
      {
        sessionId: 'older-current-repo',
        model: 'test-model',
        repoRoot: root,
        messages: [{ role: 'user', content: 'old canary: amber' }],
      },
      { memoryDir, now: new Date('2026-07-17T01:00:00.000Z') },
    )
    await saveSession(
      {
        sessionId: 'newer-current-repo',
        model: 'test-model',
        repoRoot: root,
        messages: [{ role: 'user', content: 'new canary: violet' }],
      },
      { memoryDir, now: new Date('2026-07-17T02:00:00.000Z') },
    )
    await saveSession(
      {
        sessionId: 'newest-other-repo',
        model: 'test-model',
        repoRoot: '/other-repo',
        messages: [{ role: 'user', content: 'wrong canary: scarlet' }],
      },
      { memoryDir, now: new Date('2026-07-17T03:00:00.000Z') },
    )

    await withServer(async (baseUrl, requests) => {
      const result = await runCli(root, baseUrl, ['--continue', 'Which canary is current?'])

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      const messages = requests[0]?.messages ?? []
      expect(messages.some((message) => message.content?.includes('new canary: violet'))).toBe(true)
      expect(messages.some((message) => message.content?.includes('wrong canary: scarlet'))).toBe(
        false,
      )
    })
  })

  it('reports a corrupt resumed session and leaves its bytes untouched', async () => {
    const root = await tempRoot()
    const memoryDir = path.join(root, 'memory')
    const sessionsDir = path.join(memoryDir, 'sessions')
    const corruptPath = path.join(sessionsDir, 'broken.json')
    const corruptBytes = '{broken session\n'
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(corruptPath, corruptBytes)

    await withServer(async (baseUrl) => {
      const result = await runCli(root, baseUrl, ['--resume', 'broken', 'continue'])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('Invalid saved session broken')
      expect(await fs.readFile(corruptPath, 'utf8')).toBe(corruptBytes)
    })
  })

  it('does not create sessions for an ordinary piped one-shot', async () => {
    const root = await tempRoot()
    await withServer(async (baseUrl) => {
      const result = await runCli(root, baseUrl, ['ordinary scripted prompt'])

      expect(result.exitCode).toBe(0)
      await expect(fs.access(path.join(result.memoryDir, 'sessions'))).rejects.toThrow()
    })
  })

  it('lists saved sessions read-only without requiring an API key', async () => {
    const root = await tempRoot()
    const memoryDir = path.join(root, 'memory')
    await saveSession(
      {
        sessionId: 'list-me',
        model: 'model-visible',
        repoRoot: root,
        messages: [
          {
            role: 'user',
            content:
              'A long first prompt\nwhose whitespace is normalized and whose preview is intentionally longer than sixty characters.',
          },
          { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
        ],
      },
      { memoryDir, now: new Date('2026-07-17T04:05:06.000Z') },
    )
    const snapshotPath = path.join(memoryDir, 'sessions', 'list-me.json')
    const before = await fs.readFile(snapshotPath, 'utf8')

    const result = await runSessionsCli(root, memoryDir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('list-me')
    expect(result.stdout).toContain('2026-07-17T04:05:06.000Z')
    expect(result.stdout).toContain('2')
    expect(result.stdout).toContain('model-visible')
    expect(result.stdout).toContain('A long first prompt whose whitespace is normalized')
    expect(await fs.readFile(snapshotPath, 'utf8')).toBe(before)
  })

  it('keeps the query outcome completed when session persistence fails', async () => {
    const root = await tempRoot()
    const badMemoryDir = path.join(root, 'not-a-directory')
    await fs.writeFile(badMemoryDir, 'blocking file')
    process.env.OCTONOESIS_MEMORY_DIR = path.join(root, 'working-memory')
    process.env.OCTONOESIS_DISABLE_MEMORY = '1'
    process.env.OCTONOESIS_DISABLE_COMPACT = '1'
    const provider: LLMProvider = {
      name: 'anthropic',
      async *createMessageStream(): AsyncIterable<StreamEvent> {
        yield { type: 'text_delta', text: 'completed despite store failure' }
        yield { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } }
      },
    }
    setProvider(provider)

    const generator = query('finish normally', {
      repoRoot: root,
      memoryDir: badMemoryDir,
      persistSession: true,
      sessionId: 'fail-soft-session',
      messages: [],
      config: DEFAULT_CONFIG,
    })
    let step = await generator.next()
    while (!step.done) step = await generator.next()

    expect(step.value.exit_reason).toBe('completed')
    expect(step.value.final_message).toBe('completed despite store failure')
    expect(await fs.readFile(badMemoryDir, 'utf8')).toBe('blocking file')
  })
})
