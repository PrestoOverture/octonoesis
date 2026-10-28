import { mkdtemp, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// biome-ignore lint/suspicious/noExplicitAny: Bun runtime types are not installed in this project
declare const Bun: any

export const projectRoot = path.resolve(import.meta.dir, '../..')

export async function tempRoot(): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), 'octonoesis-eval-test-')))
}

export function isolatedEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    SPARK_API_KEY: '',
    OCTONOESIS_REPO_ROOT: root,
    OCTONOESIS_MEMORY_DIR: path.join(root, '.memory'),
    OCTONOESIS_DISABLE_MEMORY: '1',
    OCTONOESIS_DISABLE_COMPACT: '1',
  }
}

export async function run(
  cmd: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = isolatedEnv(cwd),
  input = '',
): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = Bun.spawn(cmd, { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  child.stdin.end(input)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  } finally {
    clearTimeout(timeout)
  }
}

export function mockProvider(respond: (body: Record<string, unknown>) => unknown[]) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request) {
      const chunks = respond((await request.json()) as Record<string, unknown>)
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
}

export function toolChunk(name: string, input: unknown, index = 0) {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: `call_${index}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        },
      },
    ],
  }
}

export function providerEnv(root: string, port: number): NodeJS.ProcessEnv {
  return {
    ...isolatedEnv(root),
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: 'mock-key',
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  }
}
