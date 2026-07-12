import { describe, expect, it } from 'bun:test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// biome-ignore lint/suspicious/noExplicitAny: Bun subprocess typing is not available in tsconfig
declare const Bun: any

const describeDarwin = (
  describe as typeof describe & { skipIf: (condition: boolean) => typeof describe }
).skipIf(globalThis.process.platform !== 'darwin')

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function runUnsandboxed(command: string): Promise<number> {
  const child = Bun.spawn({ cmd: ['bash', '-c', command], stdout: 'ignore', stderr: 'ignore' })
  return child.exited
}

describe('CLI sandbox option', () => {
  it('advertises the opt-in --sandbox flag', async () => {
    const process = Bun.spawn({
      cmd: ['bun', 'src/cli.tsx', '--help'],
      cwd: processCwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('--sandbox')
  })

  it('fails at startup when sandbox-exec cannot be discovered', async () => {
    const env = {
      ...globalThis.process.env,
      PATH: '',
      LLM_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    }
    const child = Bun.spawn({
      cmd: [globalThis.process.execPath, 'src/cli.tsx', '--sandbox', 'test prompt'],
      cwd: processCwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(code).not.toBe(0)
    expect(stderr).toContain('Sandbox requested but macOS sandbox-exec is unavailable')
    expect(stderr).not.toContain('ANTHROPIC_API_KEY is not set')
  })
})

describeDarwin('CLI sandbox one-shot execution', () => {
  it('keeps the permission prompt and executes the approved Bash call inside sandbox-exec', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'octonoesis-cli-sandbox-'))
    const escapeRoot = await mkdtemp('/var/tmp/octonoesis-cli-sandbox-escape-')
    const escapedPath = path.join(escapeRoot, 'escape.txt')
    const command = `printf cli-escaped 2>/dev/null > '${escapedPath}'`
    expect(await runUnsandboxed(command)).toBe(0)
    expect(await pathExists(escapedPath)).toBe(true)
    await rm(escapedPath, { force: true })

    let observedToolCode: number | undefined
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request: Request) {
        const body = (await request.json()) as {
          messages?: Array<{ role?: string; content?: string }>
        }
        const toolMessage = [...(body.messages ?? [])]
          .reverse()
          .find((message) => message.role === 'tool')
        if (toolMessage) {
          observedToolCode = JSON.parse(toolMessage.content ?? '{}').code
          return sseResponse([
            { choices: [{ index: 0, delta: { content: 'sandbox complete' } }] },
            { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } },
          ])
        }

        return sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_sandbox',
                      type: 'function',
                      function: { name: 'Bash', arguments: JSON.stringify({ command }) },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
        ])
      },
    })
    const env = {
      ...globalThis.process.env,
      LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      OCTONOESIS_MEMORY_DIR: path.join(root, 'memory'),
      OCTONOESIS_DISABLE_MEMORY: '1',
      OCTONOESIS_DISABLE_COMPACT: '1',
    }
    const child = Bun.spawn({
      cmd: [globalThis.process.execPath, 'src/cli.tsx', '--sandbox', 'run sandbox probe'],
      cwd: processCwd(),
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    child.stdin.write('y\n')
    child.stdin.end()

    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])

      expect(code).toBe(0)
      expect(stderr).toBe('')
      expect(stdout).toContain('[Permission Request] Tool: Bash')
      expect(stdout).toContain('Allow execution?')
      expect(stdout).toContain('sandbox complete')
      expect(observedToolCode).not.toBe(0)
      expect(await pathExists(escapedPath)).toBe(false)
    } finally {
      server.stop(true)
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(escapeRoot, { recursive: true, force: true }),
      ])
    }
  })
})

function processCwd(): string {
  return `${import.meta.dir}/../..`
}
