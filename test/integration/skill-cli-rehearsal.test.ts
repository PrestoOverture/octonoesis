// biome-ignore lint/suspicious/noExplicitAny: Bun globals are provided by the test runtime.
declare const Bun: any

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`
}

function toolCall(name: string, input: Record<string, unknown>): string {
  return sse({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'skill-call',
              type: 'function',
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        },
      },
    ],
  })
}

function textResponse(text: string): string {
  return sse({ choices: [{ delta: { content: text } }] })
}

interface ProviderRequest {
  messages: Array<{ role: string; content?: string }>
  tools?: Array<{ function?: { name?: string } }>
}

async function runCli(
  root: string,
  prompt: string,
  responseFor: (request: ProviderRequest, requestNumber: number) => string,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; requests: ProviderRequest[] }> {
  const requests: ProviderRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request: Request) {
      const body = (await request.json()) as ProviderRequest
      requests.push(body)
      return new Response(responseFor(body, requests.length), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, path.join(process.cwd(), 'src/cli.tsx'), prompt],
      cwd: root,
      env: {
        ...process.env,
        LLM_PROVIDER: 'openai',
        OPENAI_API_KEY: 'local-rehearsal-key',
        OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        OCTONOESIS_REPO_ROOT: root,
        OCTONOESIS_MEMORY_DIR: path.join(root, 'memory-out'),
        OCTONOESIS_DISABLE_MEMORY: '1',
        OCTONOESIS_DISABLE_COMPACT: '1',
        ...extraEnv,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    proc.stdin.write('y\n')
    await proc.stdin.end()
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(exitCode).toBe(0)
    return { stdout, stderr, requests }
  } finally {
    server.stop(true)
  }
}

async function writeSkill(root: string, name: string, markdown: string): Promise<void> {
  const dir = path.join(root, '.octonoesis/skills')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${name}.md`), markdown)
}

describe('repository-local skill CLI rehearsal', () => {
  test('loads a real inline skill and returns its body through the main tool loop', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skill-cli-inline-'))
    roots.push(root)
    await writeSkill(
      root,
      'inline-live',
      '---\ndescription: Shape the visible response\n---\nPrefix the response with INLINE-SHAPED.',
    )
    const result = await runCli(root, '/inline-live make it visible', (request, number) =>
      number === 1
        ? toolCall('Skill', { skill: 'inline-live', args: 'make it visible' })
        : textResponse('INLINE-SHAPED: visible'),
    )

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('INLINE-SHAPED: visible')
    expect(result.requests[0]?.tools?.some((tool) => tool.function?.name === 'Skill')).toBe(true)
    expect(result.requests[1]?.messages.some((message) => message.role === 'tool')).toBe(true)
    expect(JSON.stringify(result.requests[1])).toContain('Prefix the response with INLINE-SHAPED.')
  })

  test('prompts before a real fork and confines its child to the declared Read tool', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'skill-cli-fork-'))
    roots.push(root)
    await writeFile(path.join(root, 'canary.txt'), 'restricted-child-canary')
    await writeSkill(
      root,
      'fork-live',
      '---\ndescription: Inspect one canary\ncontext: fork\nallowed-tools: [Read, Bash]\n---\nRead canary.txt and report its contents.',
    )
    const forkMock = JSON.stringify({
      scriptedEvents: [
        [
          { type: 'tool_use', id: 'read-canary', name: 'Read', input: { path: 'canary.txt' } },
          { type: 'message_end', usage: { input_tokens: 2, output_tokens: 1 } },
        ],
        [
          { type: 'text_delta', text: 'READ-SEEN {{tool_result}}' },
          { type: 'tool_use', id: 'try-bash', name: 'Bash', input: { command: 'pwd' } },
          { type: 'message_end', usage: { input_tokens: 3, output_tokens: 2 } },
        ],
        [
          { type: 'text_delta', text: ' BLOCKED={{tool_is_error}} {{tool_result}}' },
          { type: 'message_end', usage: { input_tokens: 1, output_tokens: 1 } },
        ],
      ],
    })
    const result = await runCli(
      root,
      '/fork-live',
      (_request, number) =>
        number === 1
          ? toolCall('Skill', { skill: 'fork-live' })
          : textResponse('FORK-RESTRICTED: restricted-child-canary'),
      { OCTONOESIS_FORK_MOCK: forkMock },
    )

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('[Permission Request] Tool: Skill')
    expect(result.stdout).toContain('FORK-RESTRICTED: restricted-child-canary')
    expect(JSON.stringify(result.requests[1])).toContain('restricted-child-canary')
    expect(JSON.stringify(result.requests[1])).toContain('BLOCKED=true')
    expect(JSON.stringify(result.requests[1])).toContain('Tool Bash is not available')
  })
})
